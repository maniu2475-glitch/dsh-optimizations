# DSH 上下文管理现状核查（2026-10-30）

> 核查方式：读本机 active 配置 `~/.dsh/profiles/desktop/cordis.yml` + 从 `app.asar` 提取的包内 README/源码 + 当前会话真实日志 `<会话ID>` 的事件回放。
> 结论只写实测到的，推测另标。

## 一、结论先说

**本机不是"没有自动压缩"，而是已经完整启用并在真实使用中跑过 4 次。**
本次任务因此不是从零实现，而是：核实现状 → 找出与 9 项要求的真实差距 → 只补缺口 → 用受控低阈值做真实验收。

## 二、四个服务与启用状态

| 服务/插件 | 条目 | 状态 | 判定依据 |
|---|---|---|---|
| token 测量 | `@deepseek-ai/dsh-token-meter` | **启用** | `cordis.yml` L316-317，无 disabled；inspect 返回 `status: schema`（已挂载） |
| 自动压缩引擎 | `@deepseek-ai/dsh-compaction-basic` | **启用（经预设挂载）** | 顶层 L318-320 有 `disabled: true`，但**默认预设 `standard` 内部的 compaction group（L776-792）没有 disabled**，实际由预设为每个 agent 挂载 |
| 手动压缩命令 | `@deepseek-ai/dsh-command-compact` | **启用（同上）** | 顶层 L321-323 `disabled: true`；预设 group L785-786 无 disabled |
| 工具输出修剪 | `@deepseek-ai/dsh-compaction-tool-result-pruner` | **启用（同上）** | 顶层 L372-378 `disabled: true` + 配置；预设 group L787-792 无 disabled，配置 `thresholdChars: 8192 / headChars: 4096 / tailChars: 1024` |
| 大输出落盘 | `spill-local` + `spill-policy` | 启用 | L364-369，`maxInlineTokens: 12500` |
| 图片卸载 | `compaction-image-offload` | 启用 | L379-380 |

**关于顶层 `disabled: true` 与预设内启用的矛盾**：顶层这些条目是"独立挂载位"，被关掉；但默认预设 `standard`（`cordis.yml` L674 `default: standard`）为每个 agent 组合了自己的 compaction group，那三个插件在组内**没有 disabled**，所以真正生效的是预设这一份。判断生效与否不能只看顶层，这是本机配置最容易误读的地方。

## 三、触发方式（实测）

### 1. 自动触发（token 预算）
`agent/pre-step` 串行 listener，在每次请求派发前用 `ctx.tokenMeter` 给"最新持久路由请求 envelope + 当前表层"定价；压力越过阈值就"先修剪、再摘要最旧的平衡范围"。

**阈值公式（源码 `compaction-basic/lib/index.js` L129-135 实测）**：

```
messageBudgetTokens  = contextWindow − reservedCompletionTokens
pressureBudgetTokens = messageBudgetTokens − headroomTokens
thresholdTokens      = floor(min(contextWindow × thresholdRatio, pressureBudgetTokens))
retainTokens         = floor(messageBudgetTokens × retainRatio)      // 未配 retainTokens 时
```

默认 `thresholdRatio=0.8`、`headroomTokens=65536`、`retainRatio=0.16`（源码 L64-67）。

**本机当前实际数值**（会话日志 `request/context` 实测 `contextWindow=262144`，`request/header` 实测 `maxTokens=none` → 输出预留 0）：

| 量 | 值 |
|---|---|
| 上下文窗口 W | 262,144 |
| 输出预留 O | 0 |
| 余量 B（headroom） | 65,536 |
| **触发阈值** | floor(min(262144×0.8, 262144−65536)) = **196,608** |
| **近期逐字保留预算** | floor(262144×0.16) = **41,943** |

预算确实包含系统指令（surface 节点 0 的 `system/message`）、工具定义（envelope 的 `tools`）、历史（表层节点）与预留输出空间（O=0）——满足"不按消息条数触发"。

### 2. 上下文溢出恢复
`agent/request-error` listener 只响应适配器确认的 `CONTEXT_WINDOW_EXCEEDED`，绕过常规阈值做一次最大平衡头部缩减，`maxOverflowRetries=1`。

### 3. 手动触发
聊天框输入 `/compact`（无参数）。可用 `command-compact`，不消耗模型轮次；agent 忙或压缩进行中会回报"暂不可用"，期间发送的提示词排队、压缩结束后才开始。

### 4. 工具结果修剪
只在压缩触发条件满足后运行，不发模型调用，**可能让摘要整个被跳过**（修剪后已低于阈值时）。低于压力阈值的对话绝不会被触碰。

## 四、摘要存在哪里、下一轮怎么用（实测）

以本会话 4 次压缩为例，日志中的事件结构完全一致：

| 事件 | 作用 |
|---|---|
| `compaction/start` | 持久锁标记（带 `compactionId`），先写盘再摘要 |
| `compaction/summary` | **原始摘要全文**（`data.summary`），永久保留 |
| `user/message`（`source.kind = "compact-checkpoint"`，带 `surfaceOp: {op:'replace', startSeq, endSeq}`） | 用一条检查点消息**替换**旧范围，模型下一轮看到的就是它 |
| `compaction/end` | 闭合，恰好一次 |

实测 4 次：

| # | compactId | 触发 | 替换范围 | 备注 |
|---|---|---|---|---|
| 1 | `ea1f5c78…` | 自动（turn 18） | seq 17–833 | |
| 2 | `5c4c1c0d…` | 自动（turn 30） | seq 1142–1831 | |
| 3 | `218ac054…` | 自动（turn 33） | seq 2187–2337 | |
| 4 | `94f31fcd…` | **手动** `/compact`（`sourceCommandId=cmd-e99bb5e5-2`, `turn:null`） | seq 3062–3778 | 紧接第 37 轮上游 403 报错之后 |

另有 `compaction/prune` 事件 **19 次**（例：seq 903 修剪 2,795 tokens；seq 905 修剪 12,491 tokens）。

**下一轮如何生效**：替换是"就地替换表层"而非追加副本，所以后续请求的历史里旧范围不再出现，只有检查点摘要 + 保留的近尾部。会话日志里原始事件**一条没删**（`sourceEventSeqs` 完整记录了被遮蔽的 seq 列表），可精确回放。

## 五、摘要模板（实测文本）

摘要由一次独立模型调用产出，输入是会话前缀 + 固定指令，输出经 `<compacted-summary>` 标签框定。指令要求固定 8 节：
`Primary Request and Intent` / `Key Technical Concepts` / `Files and Code` / `Errors and Fixes` / `Pending Jobs` / `Current Work` / `Next Step` / `Critical Context`，
并明确要求"保留精确路径、命令、错误串、标识符、数值"、"忠实记录用户反馈与纠正"、"若已有旧检查点则合并而非照抄、丢弃过期事实"。

模型看到的检查点前导（英文原文，本会话开头可见）：
> This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.

## 六、token 估算方法（实测）

源码 `token-meter/lib/types/estimate.js`：

- `CHARS_PER_TOKEN = 4`（每 4 字符 ≈ 1 token）
- 每个内容块额外 `BLOCK_OVERHEAD = 4`；每条消息额外 `ROLE_OVERHEAD = 4`
- 工具定义：`ceil(JSON.stringify(tools).length / 4) + 4`
- 图片：默认按结构 JSON 计价；路由适配器声明图片定价时才用供应商视觉 token

有供应商返回的 usage 时会复用真实 usage（前提是 envelope 匹配且不低于下界），否则整体重新估算。
**已知偏差**：包 README 明确写"每 token 四字符的启发式对 CJK 文本与 JSON Schema 定价偏低"。中文场景实际 token 会高于估算值 → 触发点比阈值数字更早到来。

## 七、与 9 项要求的差距（初判）

| # | 要求 | 现状 | 差距 |
|---|---|---|---|
| 1 | token 预算触发，含系统/工具/历史/预留输出 | **满足** | 无。已实测公式与数值 |
| 2 | 先裁旧工具输出，再压较早历史；保留最近完整往返 | **满足** | 无。修剪器先跑，保留尾部由 retainRatio 控制；范围两端强制工具配对平衡 |
| 3 | 摘要固定保留 8 类信息 | **部分满足** | 有 Primary Request / Files / Errors / Pending / Current Work / Next Step / Critical Context / Key Concepts，但**缺"已完成并验证的结果"与"失败尝试"的独立字段**，也缺"事实/推测/未验证"的显式分层要求 |
| 4 | 区分事实/推测/未验证；保留"新要求替代旧要求"关系 | **不满足** | 指令里没有这两项要求，只笼统说"忠实记录纠正" |
| 5 | 大日志/正文/产物落盘，摘要留位置；保留原始会话 | **满足** | spill（>12500 tokens 落盘）+ 修剪原文保留在日志 + 摘要替换不删原文 |
| 6 | 不拆散未完成的工具调用与结果、不丢调用编号；不重复执行已完成操作 | **部分满足** | 范围边缘有 `toolPairingBalancedBefore/After` 强制平衡，token-meter/pruner 保 callId；但**摘要模板未要求记录"哪些写操作已完成"**，这正是"避免重复执行"的关键 |
| 7 | 校验后才切换，失败保留原状态，有限重试，避免连续触发 | **满足** | 事务式：先写 `compaction/start`，摘要后重新验证稳定性，拒绝不缩小输入的摘要，失败保留原表层；`compactionRetries=1`、`maxOverflowRetries=1` |
| 8 | 项目长期记忆与会话压缩分开管理 | **满足** | 长期记忆在 `AGENTS.local.md` + `~/.dsh/memory/`，压缩只动会话表层，两者不交叉 |
| 9 | 记录触发原因/token 前后/耗时/摘要位置/恢复结果；手动压缩与回滚 | **部分满足** | 日志有 `compactionId`、`sourceCommandId`、`shadowedTokenCount`、`shadowedSeqs`、summary 全文、时间戳；`/compact` 可手动。**但缺**：统一的压缩可达性自检、回滚方法文档化、失败上报到用户 |

**真实缺口收敛为三项**：
- **G1**：摘要模板缺"已完成并验证的结果""失败尝试"独立字段 —— 影响长任务续跑时"不重复已完成操作"。
- **G2**：摘要模板缺"事实 / 推测 / 未验证"分层与"新要求替代旧要求"关系 —— 影响任务漂移与旧决定复活。
- **G3**：缺"压缩可达性自检 + 回滚方法 + 失败可见性"的运行手册与验证脚本。

## 八、限制（如实）

- **摘要模板是包内编译产物**，写在 `app.asar` 里的 `lib/index.js`；改它等于改程序安装文件，按约束不动。G1/G2 因此只能通过**不改安装文件的手段**达成（见下方方案）。
- token 估算对中文偏低（每 token 4 字符假设），真实触发早于 196,608 这个数字。
- 压缩无法缩减系统提示词、工具定义、会话前缀，也无法拆分单个超大单元。
- `maxTokens` 截断（隐藏推理 token 可能吃满额度）会导致摘要被截短，行为与失败相同：保留最新持久表层继续。
- 本会话压缩成功 ≠ WB 代理通道健康。日志显示第 37 轮曾因长载荷触发上游 403/11128，压缩与通道可用性是两件独立的事。
