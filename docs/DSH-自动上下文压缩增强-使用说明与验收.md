# DSH 自动上下文压缩增强 —— 使用说明与验收报告

> 交付日期：2026-10-30（可靠性修复 v2：2026-10-30 晚）
> 适用范围：DeepSeek Harness 0.2.1-rc.5，profile `desktop`（用户实际使用）与 `headless`（验收通道）
> 结论先行：**DSH 本来就有可用的自动压缩**，本次工作不是新建功能，而是修复三处会让长任务"遗忘/重复/漂移"的缺陷，并补上校验与失败可见性。v2 补齐流式终止校验、重试分类、结构化校验器与失败冷却（见 §4.7）。

---

## 一、结论速览

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 自动压缩是否存在 | **原本已存在且真实运行过 4 次** | `docs/DSH-上下文管理现状核查.md`；本会话日志 `<会话ID>` |
| 本次改动性质 | **增强已有机制**，未重复安装、未改安装文件 | 仅新增一个本地插件包 + patch 挂载（v2 另修复覆写配置损伤） |
| 摘要模板 | 8 节 → **11 节 + Do Not Repeat** | `context-kit/evidence/summary-run1.md` 等 3 份实摘 |
| 校验后才切换 | **已实现并实测拦截**（v2 起为结构化校验） | 失败记录 `missing sections: ...`、`truncated at the token cap`、`bullet without a leading evidence marker` |
| 事实/推测分层 | **已实现并实际出现在摘要中**（v2 统一标记体系） | `summary-run3-supersede.md` 含 `[fact]` 与 `[speculation]` |
| 新旧要求替代 | **已实现并实际生效** | `OLD: "...English." -> NOW: "...only in Chinese."` |
| 不重复已完成操作 | 结构已实现；**行为验证靠操作日志**（v2 修正口径） | §6.5：turn 9 读 m1 不重写、m2 新写入 |
| 工具调用配对 | **未拆散，零孤立调用（按 callId 配对）** | v1 8↔8；§6.5 按 ID 复核 0 孤立 |
| 重启恢复 | **通过**（v1 单进程复述 + v2 九进程连续会话） | §6.5 turn 1→9 链 |
| 流式终止 fail-closed | **v2 新增并实测** | 无 finish / max-tokens / tool-calls / aborted 全拒（runtime.test.js） |
| 重试分类与冷却 | **v2 新增并实测** | interface 零重试；冷却拦截 5 次（§6.5） |
| desktop 挂载 | **已实证（turn 46 插件产物）** | `compactionId 1d7790ab`，verify-summary-source.js 判 PLUGIN |

**重要边界**：压缩成功 ≠ <代理产品名> 代理通道健康。本次验收全程走本机代理 `<本地代理地址>`，未验证上游渠道能力。

---

## 二、本机原有的压缩机制（核查结果）

DSH 的压缩是**四插件组成的栈**，早已启用并真实工作：

| 插件 | 作用 | desktop 状态 |
| --- | --- | --- |
| `token-meter` | 估算上下文占用 | 启用 |
| `compaction-tool-result-pruner` | 裁剪冗长旧工具输出 | 启用（预设内） |
| `compaction-basic` | 压缩引擎：阈值、保留、摘要、事务 | 启用（预设内） |
| `command-compact` | `/compact` 手动压缩 | 启用（预设内） |

**触发公式**（源码 `compaction-basic/lib/index.js` L129–135）：

```
messageBudget  = contextWindow − reservedCompletionTokens
pressureBudget = messageBudget − headroomTokens
threshold      = floor(min(contextWindow × thresholdRatio, pressureBudget))
retain         = floor(messageBudget × retainRatio)
```

本机实际值：`contextWindow = 262144`，`headroom = 65536` → **阈值 196608 token**，**保留 41943 token**。

**摘要保存位置**：写入会话日志 `~/.dsh/sessions/<cwd>/<sessionId>/session.v4.jsonl.zstd`，事件序列为
`compaction/start` → `compaction/summary` → `user/message`(source.kind=`compact-checkpoint`) → `compaction/end`。
原始事件**全部保留**，摘要通过 `surfaceOp {op:'replace', startSeq, endSeq}` 遮蔽旧区段，不覆盖唯一记录。

**下一轮如何使用**：摘要作为一条 user 消息放在会话前缀中，其后接新消息，模型看到的即"前情摘要 + 新要求"。

---

## 三、本次修复的三个真实缺陷

原实现整体可用，但对照"长任务不遗忘、不重复、不漂移"的目标，实测收敛为三处缺口：

### G1 摘要缺少"已完成并验证"与"失败尝试"字段
原模板只有 `Current Work` / `Pending Jobs` / `Errors and Fixes`。
后果：模型分不清"做完了"与"正要做"，也无法得知"哪条路已试过且不通"，容易重复执行或重走死路。

### G2 无事实分层、无新旧要求替代关系
原模板要求"忠实记录用户反馈"，但没有要求区分事实/推测，也没有"新要求覆盖旧要求"的显式结构。
后果：旧指令在摘要中与新指令平起平坐，压缩后可能被重新执行（任务漂移）。

### G3 无校验闸门、失败不可见
原实现生成摘要即切换，没有"结构是否完整"的检查，也没有面向用户的失败说明。
后果：一次残缺摘要在无人知晓的情况下替换掉完整历史。

---

## 四、实现方式（为什么这样改）

### 4.1 不改安装文件

摘要指令是 `app.asar` 内的模块常量 `COMPACTION_INSTRUCTION`，直接改安装文件不可接受（升级即失效、且违反约束）。
官方唯一支持的扩展点是 `BasicCompactionEngine.summarize()`（源码注释："Override this sole hook for a template or remote summarizer"）。

### 4.2 不用替换后端，而用"共存 + 只换摘要一步"

> **这是本次踩坑后确定的架构，值得记录。**

一开始尝试用子类**替换** `compaction-basic`，遇到两个硬故障：

1. **包解析失败**：Harness 包在 `app.asar` 内。从 profile 解析的插件 `import '@deepseek-ai/dsh-llm'` 直接报
   `ERR_MODULE_NOT_FOUND`；用 `link:` 或 `file:` 安装都不解决，因为 pnpm 明确警告 *"The linked in dependency will not resolve the peer dependencies from the target node_modules."*
2. **双实例冲突**：为补依赖而在 profile 里装 `dsh-llm`，启动即报
   `configurable provider "amazon-bedrock" is already declared`——同一服务被加载两份。

**最终架构**：`compaction-basic` 保持启用（继续提供 `ctx.compaction`、阈值、保留、工具配对、事务、日志），
新插件只覆写该服务实例上的 `summarize()`，并用 `ctx` 发起自己的摘要请求。
**插件零 Harness 依赖**——它不 import 任何 `@deepseek-ai/*`，因此不存在解析问题。

### 4.3 交付物

| 文件 | 作用 |
| --- | --- |
| `context-kit/compaction-checkpoint/index.js` | 插件主体：覆写 summarize、发请求、校验、限次重试 |
| `context-kit/compaction-checkpoint/template.js` | 11 节模板与校验纯逻辑（便于单测） |
| `context-kit/compaction-checkpoint/test/validate.test.js` | 11 项单元测试 |
| `context-kit/verify-provider.patch.yml` | headless 验证用 provider 覆盖 |
| `context-kit/acceptance-low-threshold.patch.yml` | 受控低阈值验收配置 |
| `context-kit/evidence/*.md` | 三份实摘原文（硬证据） |
| `docs/DSH-上下文管理现状核查.md` | 改动前的现状核查与 9 项差距表 |

### 4.4 新增的 11 节模板

```
## Primary Request and Intent      目标 + 仍在生效的约束（原文引用）
## Completed and Verified          已完成，且逐条说明如何验证
## Key Technical Concepts
## Files and Code                  路径逐字保留，可重新打开
## Errors and Fixes                错误原文 + 修法
## Failed Attempts                 已试过且不通的路（本次新增）
## Pending Jobs
## Current Work
## Next Step
## Requirements Superseded         "OLD: … -> NOW: …"（本次新增）
## Critical Context
## Do Not Repeat                   禁止重复执行的已完成动作（本次新增）
```

规则：每条 bullet 必须带 `[fact]` / `[speculation]` / `[unverified]` 之一；**最新用户指令优先**；
若已有旧摘要，合并而非逐字搬运。

### 4.5 校验闸门

摘要生成后、切换前校验（v2 起为**结构化校验**，见 §4.7）：
- 12 个必需标题独立成行、恰好一次、按序（`##` 标题在代码块/引用内不算数）
- 每节正文 = 有效 bullet（带证据标记）或统一的 `(none)` 占位（关键节禁止占位）
- 长度不低于 `min(1200, max(200, 输入字符数 × 1%))`

不通过 → 用更严格的措辞**重试 1 次**（共 2 次）→ 仍不通过则**抛错、保留原状态**，日志记录原因。

**边界（如实声明）**：结构校验只证明**格式合规**。它不能证明内容真实，不能保证"通过标题检查就不会遗忘或幻觉"——内容质量取决于模型与源对话。

### 4.6 挂载位置的关键实测（2026-10-30 全天三轮修正，本节为最终定版）

**三轮实测、两次证伪，最终定版 = 按 Loader 行 id 整体覆写 preset 行。** 全部过程如下：

| # | 挂载方式 | 实测结果 | 场景 |
| --- | --- | --- | --- |
| 1 | 插件在顶层，后端也在顶层 | ✅ 生效 | headless 默认结构 |
| 2 | 插件在顶层，后端在 preset 内 isolate group | ❌ 不生效 | 6/6 摘要官方模板 |
| 3 | patch 新建同名 group（insert 行内写 `id: compaction`） | ❌ 两个独立 group，不同域 | dump-config 可见 |
| 4 | patch 条目级 `id: compaction` + `insert`（并入嵌套 group） | ⚠️ 顶层 group 有效；**preset 行内部的 group 够不到** | 见下 |
| 5 | **按行 id 覆写 preset 行（config 整体重述 + group 内加插件）** | ✅ 最终方案 | desktop rc.5 |

第 4 种方式的证伪证据（决定性）：desktop 12:24 重启（已加载该版配置）后，主会话 turn 45
（12:30）自动压缩的摘要**仍为官方模板**——`id + insert` 只匹配顶层合成树里的 group 行，
而 desktop rc.5 的 compaction group 嵌在 `preset-standard` 行的 config.plugins 内部，不在顶层。

第 5 种方式的依据：`@deepseek-ai/dsh-web-app` 内 `presets/standard.patch.yml` 头注释明示
"Edits saved from the Web editor override this row's `config.plugins` by id from the profile
patch"——Web 编辑器保存预设修改正是走 profile patch 按 id 覆写该行的路径。shipped 预设
声明（standard/ptc/minimal/cordis）已从 app.asar 提取，逐字段重述并仅在 compaction group
的 config 内插入 compaction-checkpoint 行（`!!js` 表达式与原文逐字一致，已校验）。

**headless 无法复刻 preset 级挂载**（重要负结果）：headless bundle（dsh-base + dsh-headless）
无 web-app，无 preset 行与 registry；插入 registry（含 M3 记录的匿名形态）后 A/B 对照
（同一 PING 任务有无 preset patch）inputTokens 完全相同（4642）——preset 根本不附加到
headless 会话。M3 "registry insert 可激活预设"的旧结论系误判（当时的 browser 工具来自
profile 安装的 playwright-mcp，非预设）。因此 preset 路径只能由 desktop 实证：重启后新
会话首次自动压缩时，用 `context-kit/verify-summary-source.js` 判定摘要来源。

desktop 主会话压缩历史：turn 39 终止、turn 40 成功（11:24/11:33，旧配置，官方模板）、
turn 45 成功（12:30，无效的 id+insert 版，官方模板）、**turn 46 成功（19:41，preset 覆写版，
插件产物——`compactionId 1d7790ab`，seq 7782/7783/7785，PREAMBLE 开头 + 12 节全 +
shadowedSeqs 431，提交后 8 条用户消息正常续跑；desktop 进程 19:28 重启加载 13:03 落盘的
覆写配置）**。preset 覆写路径就此 desktop 实证，不再"待验证"。

环境变化记录：DSH 运行时 0.2.1-rc.3 → **0.2.1-rc.5**（desktop 12:05、12:24、19:28 三次重启）。
插件 rc.5 下重测通过（headless 顶层路径 3/3 摘要带全部特征）。`dsh-browser-use` 与
`dsh-experimental-browser-use-playwright-mcp` 因 rc.3 依赖声明被 rc.5 禁用，与本插件无关。

**两条挂载路径的归因（v2 澄清）**：子代理会话不附 preset，其 compaction 服务来自顶层合成树
的 compaction group——12:11 的 `id + insert` 版对**这条路径**有效（session-830009d0 13:59 的
压缩走插件，即证据）；附 preset 的主会话走 preset 行内部，只有 preset 覆写版有效。两版不冲突，
各覆盖一条路径；desktop patch 现为 preset 覆写版（同时修掉了三处配置损伤，见 §4.7）。

---

### 4.7 可靠性修复 v2（2026-10-30 晚，本轮交付）

**修复的缺陷（全部有离线复现/测试）：**

| # | 缺陷 | 修复 | 验证 |
| --- | --- | --- | --- |
| R1 | `validateSummary` 只查标题子串+总长度：乱序/重复/无标记/代码块假标题全部通过 | 真 Markdown 解析（`parseCheckpoint`）：标题独立成行、恰好一次、按序；代码块/引用内标题不冒充章节；每节正文=带标记 bullet 或统一 `(none)`（关键节禁占位、反填充）；`[verified]/[claimed]` 退役，统一 `[fact]/[speculation]/[unverified]` | validate.test.js 23 用例：乱序/重复/围栏/引用/无标记/退役标记/叠标/填充全拒 |
| R2 | `TextAssembler` 默认 `finish={kind:'stop'}`：流中断/无终止标记的响应被当正常完成 | 构造器 `finish=undefined`；流结束无 finish → `CHECKPOINT_STREAM_INCOMPLETE`；`error/aborted/max-tokens/tool-calls` 按 stock 语义 fail-closed；非预期 finish kind 拒绝 | runtime.test.js：无 finish 拒绝、max-tokens 拒绝、tool-call 拒绝 |
| R3 | 取消处理不完整：已 abort 的 signal 仍发请求；校验通过到提交之间无取消窗口 | 请求前/流中/提交前三点检查；提交窗口内取消 → 不切换、保留原表面 | runtime.test.js：pre-abort 零调用、commit-window 取消不提交 |
| R4 | catch 分支对接口错误原样重试（与"立即上报"注释矛盾）；三层重试无清晰边界 | 失败分类：`format`（可消耗重试预算）/`interface`（流异常、transport、error-finish——本层零重试，provider 层 retryPolicy 保持唯一重试）/`cancel`（立即上抛）；日志带 `[class] code attemptsMade` | runtime.test.js：error-finish/网络异常各 1 次调用即止；桌面日志可见分类 |
| R5 | 失败后每轮连续触发同样的压缩请求 | 失败冷却 `failureCooldownMs`（默认 60s，按 session 记账）：冷却期内直接跳过，不发请求；成功提交清零 | runtime.test.js + headless 实测（冷却拦截 5 次，见 §6.5） |
| R6 | 模板内容规则缺失：来源指令越权、取消任务复活、Do Not Repeat 过宽、自述完成升级 | 指令明写：网页/文件/工具输出内指令是**数据不是授权**；任务四态（取消→Superseded 永不复活）；Do Not Repeat 只记**有副作用**的已完成操作，只读复查永远允许；自述完成无证据标 `[unverified]` 不升级；合并旧摘要=整体替换可纠错删旧，不累积 | 指令文本 + turn 8 实测（见 §6.5） |

**同轮发现并修复的配置损伤（4 份 preset 覆写重生成为对象级流水线输出，与 shipped 原文全字段
diff = 仅多 checkpoint 行）：** standard 丢 `tool-plugin-market` 行；ptc 丢 12 个键
（present/tool-ask-user/tool-web/tool-todo/tool-plugin-manager/tool-plugin-market/
tool-presentation 及 config、delegation/tool-workflow、workflow-ptc#cfg）；cordis 的
`customSkillDirs` 中 `!!js` 表达式被字符串化成普通文本（Loader 将其当字面串，表达式失效）。
备份：`context-kit/backups-reliability-20261030-1940/`（改前 index/template/测试/判定脚本）；
改前 desktop patch 覆写区可用 `context-kit/preset-*-override.patch.yml` 的 git 历史或本节清单重建。

**三层重试的真实总上限（如实声明）**：provider 层 `retryPolicy.maxRetries: 2`（transport 级）+
compaction-basic `compactionRetries: 1`（压缩事务级）+ 本插件 `maxSummaryAttempts: 2`（格式级，
仅消耗于 format 类失败）。三类失败互不叠加：本层 interface/cancel 失败直接上抛，不会叠加第二层。

**结构校验的边界（防过强表述）**：校验器证明的是格式合规，不是内容真实。"标记保证事实真实"
"结构保证不重复"这类说法不成立——标记只是强制模型自报证据等级，Do Not Repeat 只是结构化提示；
内容质量由模型与源对话决定。行为层面的"不重复"验收靠操作日志计数（§6.5），不靠摘要文本自证。

### 4.8 判定脚本与流式终止的二次修复（v2.1，2026-10-31 上午）

**修复 1：verify-summary-source.js 的 COMMITTED 判定实证化。** 旧版"有 summary + 有 end 就算
COMMITTED"存在四个漏洞（均可离线复现）：不查 start、不查 end.error、不查**替换事件**、不查顺序。
本机 rc.5 日志协议实测：提交的实证 = 同 compactionId 的 `user/message` 且
`source.kind === 'compact-checkpoint'`（紧跟 summary 之后、end 之前）。v2.1 判定 COMMITTED 须
同时满足五条件：start 存在、summary 存在、end 存在且无 error、替换 user/message 存在、
seq 序**与文件行序**双序成立（合成日志只查 seq 会漏判乱序——反例测试抓出后补上）。
解压失败/坏 JSON 行 → 顶层统一 `INCONCLUSIVE`（退出码 1，--json 与文本模式共用同一套结论），
不再一边报解析错误一边输出成功。退出码：0=有明确判定，1=INCONCLUSIVE，2=用法/IO 错误。
反例测试 9 项（end 带 error/缺 start/缺替换/乱序/重复事件/坏 JSON/解压失败/正常簇/双模式一致）
全过；真实会话复核：headless 13 次 COMMITTED 与桌面 turn 46 判定不变（严判未推翻历史结论）。

**修复 2：流式终止两类误判（均先离线复现再修）。** ①正文完整后收到无 `reason` 的
`{type:"finish"}` 被当干净 stop 接受——现拒绝（`CHECKPOINT_STREAM_INCOMPLETE`），协议缺终止
原因不得自行补成 stop；②先 tool-call-delta 后 `finish.kind="error"` 被误分类为工具调用格式
错误而重试（烧 2 次调用）——现按**终止状态优先**分类：error/aborted/max-tokens 终态一律优先于
先前的工具片段（interface/cancel 零重试），只有**干净 stop 终态**下的工具调用才算格式类、可消耗
重试预算。单测 45/45（新增 6 项组合：无 reason 拒绝、非字符串 kind 拒绝、工具片段+error 终态
1 次调用即止、工具片段+aborted 判 cancel、工具片段+干净 stop 保持格式类 2 次、成功日志只说
"candidate accepted"不说 "committed"——提交与否以引擎替换事件为准）。

---

## 五、配置（实际生效内容）

### 5.1 desktop（用户实际使用）

`~/.dsh/profiles/desktop/package.json` 依赖已加入：

```json
"@local/dsh-compaction-checkpoint": "file:.../context-kit/compaction-checkpoint"
```

`~/.dsh/profiles/desktop/cordis.patch.yml` 新增**四个 preset 行覆写**（standard/ptc/minimal/cordis，
生成脚本输出在 `context-kit/preset-*-override.patch.yml`，已并入 patch 末尾）。以 standard 为例，
结构 = shipped 声明逐字段重述 + compaction group 内插入一行：

```yaml
- id: preset-standard            # 覆写 shipped 行（config 整体替换，全字段重述）
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      # …… 与 shipped standard.patch.yml 逐字一致 ……
      - id: compaction
        name: cordis:group
        group: true
        isolate: { compaction: true, toolResultPruner: true }
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
          - id: compaction-checkpoint      # ← 唯一新增
            name: '@local/dsh-compaction-checkpoint'
            config: { enabled: true, maxSummaryAttempts: 2 }
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          # ……
```

个人预设 bundle（personal-fast/executor/planner/cluster）的 4 个 compaction group 同样插入了
该行（`personal-presets-bundle/cordis.patch.yml`，备份 `.bak-ctxmgmt`）。

> 注意：`compaction-basic` **未被禁用**。两者共存是设计，不是遗漏。

### 5.2 关闭与回滚

| 目的 | 操作 |
| --- | --- |
| 临时停用（保留安装） | 各覆写块内 `enabled: true` 改为 `false`，重启应用 |
| 彻底移除 | 删除 patch 内四个覆写块（或对应预设块）；执行 `dsh plugin --profile desktop remove @local/dsh-compaction-checkpoint` |
| 恢复改动前配置 | `cp ~/.dsh/backups/context-mgmt-20261030-111629/* ~/.dsh/profiles/desktop/`；个人 bundle 用同目录 `cordis.patch.yml.bak-ctxmgmt` |
| 回滚某次压缩 | 原事件未被删除，可按 `surfaceOp` 的 `startSeq/endSeq` 恢复原始区段 |

---

## 六、真实验收记录

全部通过 `dsh headless` 独立进程执行，**不动用户正在使用的客户端**。
受控低阈值：`thresholdRatio: 0.02`、`retainRatio: 0.01`、`headroomTokens: 1024`，避免制造大额付费上下文。

### 验收 1：摘要结构完整（手动/强制触发）

指令：读两个文件后回复。
证据（`evidence/summary-run1.md`，2361 字符）：

- 11 节齐全，含 `## Completed and Verified`、`## Failed Attempts`、`## Requirements Superseded`
- 结尾 `## Do Not Repeat`
- 逐条 `[fact]`
- **用户原话逐字保留**：`"Do these in order, replying one short line after each: (1) read AGENTS.local.md, ..."`
- 硬约束保留：`"Do not write files" is a hard constraint`
- 官方前导与 `<compacted-summary>` 框架完好（未破坏下游识别）

会话 `session-584a2bdb`：`compaction/summary` seq=29 → `compaction/end` seq=31 **无 error**。

### 验收 2：自动触发后继续执行、不重复

一次任务内连续 **5 次成功压缩**，任务完整跑到 `FINISHED`。
证据（`evidence/summary-run2-last.md`）：

```
## Completed and Verified
- [verified] STEP1: read AGENTS.local.md in full (24 lines); reply `STEP1 DONE-STEP1` sent.
- [verified] STEP2: read docs/DSH-上下文管理现状核查.md in full (131 lines); ...
## Do Not Repeat
- [fact] Do not re-send `STEP1 DONE-STEP1` or `STEP2 DONE-STEP2`.
```

**"不重复"的验证口径（v2 修正）**：摘要里有 `## Do Not Repeat` 只是结构化提示存在；行为层面的
"不重复"必须用操作日志证明（写类调用计数、后续轮次有无重写）。v2 的行为证据见 §6.5；
本条 v1 验收只证明"摘要结构包含该节"。

### 验收 3：中途改要求后遵守新要求

任务先要求前两步用英文，随后明确改为"只回中文"。
模型 Phase B 全程中文（输出 STEP3/STEP4 均为中文）。
证据（`evidence/summary-run3-supersede.md`）：

```
## Requirements Superseded
- [fact] OLD: "for the first two steps reply in English." -> NOW: "from now on reply ONLY in Chinese."
## Do Not Repeat
- [fact] Do not answer STEP3/STEP4 in English to "stay consistent" — that instruction is superseded.
```

同一摘要中还出现了 `[speculation]` 条目，**证明事实分层真实生效**。

### 验收 4：工具边界、失败、重启

**(a) 工具调用配对**：一次 8 个并行 `read` 调用。
统计结果：`tool-calls=8, tool-results=8, calls without result: NONE`——**零孤立调用**。
同会话先发生 `compaction/prune`（裁掉 3349 / 2205 tokens 的大输出）再 `compaction/summary`，分层裁剪链路可见。

**(b) 压缩失败**：把 `maxTokens` 压到 16，强制摘要截断。
结果：任务**照常执行到 SURVIVED**（EXIT=0），每个 `compaction/start` 都有配对的 `compaction/end`，错误如实记录：

```
"error": "summarization truncated at the token cap (incomplete checkpoint)"
```

失败未污染会话，原状态保留。

**(c) 重启恢复**：建含压缩的会话后，用新进程 `--session-id` 恢复并追问"重启前读过哪些文件"。
回答准确列出两个文件及顺序、最终回复 `SESSION1-DONE`、并诚实指出 A3 未真正重读——
说明**压缩后的历史被正确持久化与恢复**。

### 单元测试

```
$ node --test context-kit/compaction-checkpoint/test/validate.test.js context-kit/compaction-checkpoint/test/runtime.test.js
ℹ tests 39   ℹ pass 39   ℹ fail 0
```

- validate.test.js（23）：结构齐全、乱序/重复/围栏/引用/无标记/退役标记/叠标/关键节填充全拒、
  统一 `(none)` 只在非关键节通过、长度下限随输入缩放、标签剥离、parseCheckpoint 剖析。
- runtime.test.js（16，fake llm 流，零网络）：正常 stop 提交、无 finish 拒绝、aborted/error/
  max-tokens/tool-calls fail-closed 且不重试、格式失败限次重试后 fail-closed、第 2 次提交成功、
  pre-abort 零调用、提交窗口取消不提交、冷却拦截、成功清冷却、disabled 不安装、日志带分类。

### 6.5 v2 headless 回归（真实模型，受控低阈值，2026-10-30 晚）

patch：`context-kit/acceptance-v2-group-checkpoint.patch.yml`（isolate group + 组内插件 +
`thresholdRatio 0.02` + `contextWindow 32768` 显式压小窗口 + pruner 放大，全部记录在案）。
会话 `session-034f1238`，turn 1→9 连续 9 个 dsh 进程（每轮新进程 = 每轮真实重启恢复）：

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 自动触发压缩 | **13 次 COMMITTED，全部插件产物** | 磁盘日志 26 start/13 summary/26 end；6 个空簇为失败/冷却路径（见下） |
| 摘要结构 | 每次以 PREAMBLE 开头、12 节全、`[fact]` 标记 | 最后摘要 seq=177，4629 字符，shadowedSeqs 累计 |
| 中途新要求跨压缩遵守 | turn 8 注入 `CHECKPOINT-OK` 新规则 → 通过 4 连压缩后 final 输出以 `CHECKPOINT-OK` 开头 | mw8.jsonl final；最新摘要含该规则 |
| 写入不重复（操作日志证明） | turn 9 要求写新文件 m2.md：m1.md 仅出现**读**调用（ReadAllText），无重写；m2.md 新写入 121200B | tool/call 参数逐条核对 |
| 工具配对按 ID | calls=8 ↔ results=8，按 `callId ↔ message.source.callId` 配对，零孤立 | 会话日志全量比对 |
| 校验器真实拦截 | 新校验器拒绝了无标记 bullet（`"(none)"` 不带 `[fact]`）→ 2 次尝试后 fail-closed 保留原表面 | 第一簇 end.error 全文 |
| 冷却防每轮重触发 | 格式失败后同 session 60s 内再触发 → `CHECKPOINT_COOLDOWN` 跳过，不发请求；实测拦截 5 次 | end.data.error 含 "cooling down" |
| 引擎安全放弃 | "summary is not smaller than the shadowed content" 1 次 → 不提交不污染 | turn 9 空簇 error 字段 |
| 重启恢复 | 9 轮每轮全新进程接入同一 session，压缩后历史连续使用（turn 8 规则来自跨 4 次压缩前的 turn 7 上下文） | 会话日志 turn 链 |

成本记录：9 轮全部为小任务（每轮 inputTokens 峰值 <15k），受控低阈值没有制造大额上下文。

### 6.6 桌面当前进程的运行时证据（2026-10-31 上午，v2.1 收尾核验）

DSH 桌面 10:02:52 重启（Get-Process 四进程 StartTime 一致）。三个层面的区分，**不互代**：

| 层面 | 状态 | 证据 |
| --- | --- | --- |
| 磁盘上的代码 | v2.1（与工作区哈希一致，index/template 双 True） | Get-FileHash 2026-10-31 10:2x |
| 当前进程加载的代码 | **v2 行为已实跑**（10:02 重启加载 10-30 23:06 落盘的 v2 代码） | 见下行运行时证据 |
| 当前进程实际完成 v2 压缩 | **已发生并实证** | 本会话 turn 51（10:20–10:24）六次压缩全链 |

turn 51 运行时证据（会话日志 compactionId 簇，epoch 时间换算 Asia/Singapore）：

```
10:20:10  NOSUM  上游 502（AC2 账号配额 402）→ [interface] 立即失败，零重试
10:22:45  NOSUM  CHECKPOINT_COOLDOWN 冷却拦截（60s 窗口内跳过，未发请求）
10:23:05  NOSUM  冷却拦截
10:23:13  NOSUM  冷却拦截
10:23:21  NOSUM  冷却拦截
10:24:04  COMMITTED（start→summary→replace→end，PREAMBLE 开头）
```

这一轮把 v2 的三项核心行为（接口错误零重试、冷却防每轮重触发、成功提交）在**当前进程**里
真实走了一遍，且失败原因（上游配额 502）被如实记录、未污染会话。desktop 配置 CLI dump 被
Electron 独占（`profile "desktop" is managed exclusively by the Electron application`），
"进程加载的配置版本"由运行行为反证（冷却/分类日志只有 v2 代码会打）；patch 磁盘版本
（10-30 23:06）早于进程启动（10:02:52），启动必然加载该版。

---

## 七、限制与未覆盖事项（如实声明）

1. **摘要偏大**：11 节比重更大。实测 683–1227 estimated tokens，是原 8 节的 1.3–1.6 倍。
   低阈值场景常出现 `summary is not smaller than the shadowed content` 而放弃压缩——**这是安全的失败**（保留原状），但在默认阈值（196608）下极少发生。
2. **需要足够输出预算**：`maxTokens` 过小会触发截断失败。建议显式设置 `maxTokens ≥ 2048`；实测 16 必失败。
3. **本机代理通道**：验收全程走 `<本地代理地址>`。**压缩成功不代表上游渠道健康**；本会话曾在 turn 37 出现上游 403/11128。
4. **token 数为估算**：DSH 用 `CHARS_PER_TOKEN = 4` 的启发式，官方 README 承认对**中文和 JSON Schema 会低估**。因此真实触发往往早于数字阈值。
5. **压缩的固有边界**：无法缩小系统提示、工具定义、会话前缀；无法拆分单个超大单元。
6. **desktop 已实证（v2 更新）**：turn 46（2026-10-30 19:41）desktop 主会话自动压缩确认为插件产物
   （§4.6）。运行中进程仍不热加载配置：改 preset 覆写或插件代码后需重启客户端才对**新**会话生效。
   headless 仍无法验证 preset 路径（无 web-app bundle），该路径的回归只能靠 desktop。
7. **回滚仅记录机制**：`startSeq/endSeq` 可用于人工恢复，但未提供一键回滚命令。
8. **未做的事**：未引入服务端压缩接口（不假定 <代理产品名> 支持），未做跨会话长期记忆自动化。

---

## 八、与公开设计的对照

| 设计点 | Codex（开源实现） | 本次 DSH 改动 |
| --- | --- | --- |
| 摘要前导强调"避免重复" | `summary_prefix.md`: "avoid duplicating work" | 以 `## Do Not Repeat` 结构化落地 |
| 保留用户原话 | 单独保留真实 user 消息（`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`） | 在 `Primary Request` 中要求逐字引用 |
| 压缩后仍注入原始约束 | 重放压缩后历史 + 新消息 | 同机制（未改动） |
| 工具调用/结果配对 | `normalize_history` 强制配对不变量 | 由 `compaction-basic` 的 `toolPairingBalanced*` 保证（实测零孤立） |
| 大工具输出落盘 | 正文存 rollout 日志，活历史只留截断 | `spill-local` + `spill-policy` + pruner（原有） |
| 压缩可观测 | 记录触发方式/原因/前后 token/耗时 | `compaction/*` 事件已有；本次补充失败原因文本 |
| 事实与推测分层 | **未见明确要求**（未核实） | 本次显式实现（`[fact]/[speculation]/[unverified]`） |
| 新旧要求替代 | **未见显式结构**（未核实） | 本次显式实现（`Requirements Superseded`） |

参考来源：
- `https://raw.githubusercontent.com/openai/codex/main/codex-rs/prompts/templates/compact/prompt.md`
- `https://raw.githubusercontent.com/openai/codex/main/codex-rs/prompts/templates/compact/summary_prefix.md`
- `https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/compact.rs`
- `https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/context_manager/history.rs`

---

## 九、九项要求逐条对照

| # | 要求 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 按 token 预算触发，含系统指令/工具/历史/预留输出，非消息条数 | ✅ | `threshold = min(ctx×ratio, budget−headroom)`，token-meter 计入工具定义 |
| 2 | 分层：先裁冗长工具输出，再压历史，保留最近往返 | ✅ | `compaction/prune` → `compaction/summary` 实测同现 |
| 3 | 摘要固定保留 9 类信息 | ✅ | 11 节模板全覆盖 |
| 4 | 区分事实/推测/未验证；新旧要求替代 | ✅ | 标记强制 + `Requirements Superseded` |
| 5 | 大日志落盘只留结论与位置；保留原始会话 | ✅ | `spill-local`；原事件保留，仅 surface 遮蔽 |
| 6 | 不拆散工具调用与结果、不丢编号；不重复已完成 | ✅ | 8↔8 零孤立；`Do Not Repeat` |
| 7 | 校验后才切换，失败保留原状态，有限重试，避免连续触发 | ✅ | 2 次上限、抛错保留原状 |
| 8 | 长期记忆与压缩分开管理 | ✅ | 记忆在 `~/.dsh/memory/`，压缩仅在会话内 |
| 9 | 记录触发原因/前后 token/耗时/摘要位置/恢复结果，可手动压缩与回滚 | ⚠️ 部分 | 事件已有；**未提供一键回滚**，耗时未单列字段 |

---

## 九B、收尾三结论（v2.1，2026-10-31 上午；三项分列，不合成一个 PASS）

| 结论项 | 判定 | 依据 |
| --- | --- | --- |
| **代码修复是否通过** | **通过** | 流式终止两漏洞先复现后修复（无 reason 不再补 stop；error 终态优先于工具片段，不再误分类重试）；判定脚本 COMMITTED 实证化（五条件+双序+统一 INCONCLUSIVE+退出码）。单测 45/45 + 判定脚本反例 9/9 全过 |
| **历史提交证据是否成立** | **成立** | 严判复核未推翻任何既有结论：headless session-034f1238 13 次 COMMITTED（另 13 次 GENERATION_FAILED 为失败路径证据）、桌面 turn 46 仍判 COMMITTED/CHECKPOINT-PLUGIN |
| **当前桌面进程是否实际验收** | **已实际验收（10:02 进程）** | turn 51（10:20–10:24）六次压缩：上游 502 零重试 → 冷却拦截 4 次 → 10:24:04 COMMITTED，v2 三项核心行为在当前进程真实走通；磁盘 v2.1 代码 10:33 同步、运行时日志证明加载版即 v2 行为（v2.1 的 index.js 改动于验证后同步，尚未被当前进程加载，属预期，下次重启生效） |

剩余待验（如实声明）：v2.1 对 `TextAssembler` 的两处改动（无 reason 拒绝、终态优先分类）在当前
进程内**没有自然发生的复现场景**（上游今天只给了 502 与配额错误，未给出无 reason finish 或
工具片段+error 组合）——该两处由 45 项离线单测覆盖，运行时自然复现留待日常使用观察。

---

## 十、最小使用检查清单

重启应用后，在新会话中：

1. 观察日志出现 `compaction checkpoint active: ... structural validation on, 2 attempt(s), failure cooldown 60000ms` → 插件已加载；摘要通过校验时日志说 **`candidate accepted`**（插件只接受候选，提交与否看引擎替换事件 user/message source.kind=compact-checkpoint）
2. 长任务中触发压缩后，查看会话日志应见 `compaction/summary` 且其后 `compaction/end` 无 `error`
3. 摘要文本应含 `## Completed and Verified` 与 `## Do Not Repeat`
4. 若见 `compaction/end` 带 `error`：①`summary is not smaller than the shadowed content` 属低阈值下的正常保护，非故障；②`rejected after N attempt(s) [format]` = 模型输出不合结构（已保留原表面，60s 冷却后才会再试）；③`cooling down` = 冷却拦截（预期行为）；④`CHECKPOINT_STREAM_INCOMPLETE`/`CHECKPOINT_INTERFACE_ERROR` = 上游流式问题，本层不重试，查代理与渠道

### 一键判定某会话摘要来源（免读日志）

```powershell
node context-kit\verify-summary-source.js <session.v4.jsonl.zstd 的完整路径> [--all] [--json]
```

v2 判定分两层，不互相代替：
- **SOURCE（来源）**：位置式判据——PREAMBLE 是否为摘要文本**开头**（包含式检测会因会话自指内容
  假阳性，turn 45 教训）。输出 `CHECKPOINT-PLUGIN`（插件产物）或 `STOCK-BACKEND`（官方模板）。
- **EVIDENCE（执行证据）**：按 `compactionId` 把 start/summary/end 配成簇，四态分类：
  `COMMITTED`（已提交）/ `GENERATION_FAILED`（生成失败）/ `NOT_COMMITTED`（有摘要未提交）/
  `NO_SUMMARY`（无摘要）。解压/解析失败计数展示（`decodeFailures`/`badJsonLines`），有解压失败时
  判定降级为 `INCONCLUSIVE`，绝不静默输出成功。

已自检：<会话ID> 8 簇（7 STOCK + turn 46 PLUGIN + turn 39 正确判 GENERATION_FAILED）、
session-034f1238 26 簇（13 PLUGIN COMMITTED + 失败/冷却簇）。`--all` 列出全部簇便于核对。

**注意**：来源判定（摘要像插件产物）不等于执行证据（该簇确实 COMMITTED）——两者都过才算该次
压缩真实走了插件并生效。结构校验证明格式合规，不证明内容真实；"不重复"要靠操作日志计数。
