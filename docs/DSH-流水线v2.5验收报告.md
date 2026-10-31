# 验收报告 · 网页调研流水线 v2.5（稳定复用版）

日期：2026-10-30 00:00–01:35。对应需求：四项升级（全量清单校验 / 指纹传播 / 内容支持分层 / 状态统一）+ 四个补做测试（删源 / 改源 / 错误结论 / null）+ 实际需求验收。

## 一、四项升级的落地

| 需求 | 实现 | 证据 |
|---|---|---|
| 1. 来源清单检查全部文件 | `00-manifest.json` 登记全部来源（id/url/title/fetchedAt/fingerprint）；QC 查一"条目数=文件数、id 连续、逐文件非空+指纹复算（一个不许跳过）" | R1-QC：4/4 指纹复算一致，s1-s4 逐条列出 |
| 2. 记录主题/参数/来源指纹；上游变化→下游重生成 | manifest 存 topic+来源指纹；指纹链 02头行=sha(manifest)、03头行=sha(02)、04头行=sha(03)；任一上游变化 → 头行比对失败 → 该阶段自动判过期重做 | T2a/T2b：口径迁移后 02/03 时间戳 00:43:15→01:05:59→01:10:47，头行全部换新 |
| 3. QC 增"结论是否被引用内容支持"，区分事实/推断/未核实 | 报告逐条标注 [事实]（原文直接支持）/ [推断]（写明推理链）/ [未核实]（说明原因）；QC 查四逐条在来源原文找支持片段 | R1：40 [事实] 全部有原文支持、5 [推断] 推理链成立、3 [未核实] 属实；T3 假事实被拦截 |
| 4. 统一阶段状态与磁盘校验；null/不完整/校验失败不得标成功 | 状态机：null/schema 违约→ABORTED（无成功标记）；status 枚举白名单；成功只由 QC 终审发出；主会话每阶段 pwsh 磁盘实证 | R0：digest-null→ABORTED@digest；R1-QC 头行格式缺陷被我方复验发现并修复回路 |

## 二、四个补做测试（全部通过）

| 测试 | 操作与预期 | 实测结果 |
|---|---|---|
| T1 删除一个来源 | 删 s2.md → 重跑 → 检测+最小修复 | ✅ collect 重建 s2（web_fetch 原URL），manifest 未动（mtime 00:35:49 不变），其余来源未重抓——最小修复成立。**附赠发现**：全文指纹含 fetchedAt 必漂移的协议缺陷 → v2.5 修正为正文段指纹 |
| T2a 修改一份来源 | 指纹口径迁移=上游真实变化 | ✅ manifest 4 条目指纹全部重写（新 manifestSha=a7cb01569ba46b4b≠旧 2fac30157fcb2995），fetchedAt/主题字段原样 |
| T2b 保留正确链接+错误结论 | 前半由 T2a 驱动；错误结论在 T3 注入 | ✅ 02/03 双双过期重做（时间戳铁证）；T3 见下 |
| T3 错误结论（+null 注入） | 注入"付费订阅 Pro 授权"假 [事实] → QC 拦截 → 修复 → 复查 | ✅ QC 查四 FAIL（三重反证：s2 原文无 / 重抓 registry JSON 无商业字段 / Apache-2.0 直接矛盾）→ 修复代理删假事实+合并重复标题 → 复查 PASS（55 引用账目自洽 56−1）。null 注入在 R0 已验：ABORTED 不标成功 |

"只重跑必要步骤"证据链：T1 只重建 s2（其余 skipped 语义）；T2b 只重做 02/03（来源未重抓）；T3 只重写报告（来源/笔记/manifest 全未动）。

## 三、实际需求验收（R1，不再用 MCP 介绍样例）

主题：**Playwright MCP（@playwright/mcp）0.0.80 的工具清单与能力面**——正是本机浏览器功能所依赖的组件。

- 运行目录 `runs/pmcp-tools/`，四阶段全量：4 权威来源（GitHub 元数据 / npm registry 0.0.80 JSON / README v0.0.80 上下篇）→ 30 条发现 → 19628B 结构化报告（55 处引用）→ QC PASS
- 报告真实有用：71 个 browser_* 工具按 9 能力组清点（核心 23+标签页 1+config 1+network 4+storage 17+devtools 13+vision 6+pdf 1+testing 5）；core 23 工具逐参数表；--caps opt-in 机制；profile 三模式与并发约束；stdio/HTTP/Docker 部署；官方安全边界声明（非安全边界、workspace 文件围栏）
- **流水线自己抓出了来源的错误**：README 概括小计"核心 21+storage 16"与其逐条枚举（23/17）不符——报告以逐条枚举为准并显式标注该计数陷阱（QC 查四复算 23+1+1+4+17+13+6+1+5=71 自洽）
- 真实异常处置：npm 包页 403 反爬→registry JSON；README fetch 网络错误→重试+jsdelivr 镜像交叉；GitHub HTML 骨架→api.github.com 补齐（均记入 issues）

## 四、过程中发现并修复的架构问题（如实）

1. **workflow 工具的 agent() 返回 null**（本会话 22:46 模型切换后出现）：8 次运行连 `{"status":"ok"}` warmup 都返回 null，而同任务直连 subagent 正常。**根因未定位**（候选：会话模型切换历史、引擎结果回传/校验管线、会话内状态，均未证实），**暂记待定位，不定性为引擎故障**。v2.5 起改为主会话直连编排（每阶段后主会话 pwsh 磁盘实证，比代理自报更硬）；v2.5.1 起 workflow 脚本标**停用**，恢复判据=warmup 对照实验通过。
2. **含哈希字段的返回 schema 违约率高**（模型算完哈希把值当回复发）：v2.3 起返回 schema 零哈希字段，哈希只活在磁盘头行与代理内部逻辑——此后 digest/report/QC 全部稳定。
3. **全文指纹含时间戳必漂移**（T1 暴露）：v2.5 改正文段指纹，"重抓但内容未变"不再误伤。
4. QC 曾把头行指纹写成无 `sha:` 前缀——主会话复验发现，代理修复；格式复验已纳入固定流程。

## 五、产物清单与回滚

- 模板：`pipelines/web-research-report/`（TEMPLATE.md 唯一入口说明 / STAGES.md 阶段语义 / pipeline.workflow.js 停用脚本）
- 运行证据：`runs/t-r0-null/`（R0）、`runs/pmcp-tools/`（R1+T1/T2/T3）、`runs/t4-t5-controlled/`（T4/T5 补测）、`runs/mcp-core/`（v1 遗产）
- 记忆：AGENTS.local.md M5 v2.5.1 + ~/.dsh/memory/default-workspace/pipeline-web-research.md
- 回滚：删 `pipelines/` 目录即完全移除（纯新增，无既有文件改动）

## 六、v2.5.1 整改与补测（2026-10-30 上午）

### 6.1 入口统一
- TEMPLATE.md 明确：**主会话直连编排为当前唯一执行方式**（逐阶段派直连子代理 + 主会话 pwsh 磁盘校验，校验不过不放行）。
- `pipeline.workflow.js` 标 **已停用**，不再写"引擎修复即可用"；恢复判据只有 warmup 对照实验（workflow 单 agent 极简 JSON vs 直连 subagent 同任务）。

### 6.2 旧脚本三处修正（修正≠可用）
| 修正项 | 原状 | 现状 |
|---|---|---|
| 指纹口径 | 整文件 Get-FileHash | 来源=正文段（`## 关键事实` 标题行起含该行，SHA256 前16位）；02/03/04=整文件。**v2.5.2 起该口径定名为 `body-v2` 并写入 manifest 顶层 `fingerprintAlgo` 字段**（见 §7） |
| 修复意见传递 | repairNote 只赋值、未拼进 report 任务（缺陷） | 【修复指令】块真实注入第二轮 report 任务，含全部 QC issues |
| PASS/FAIL 判定 | `.includes('PASS')` 宽容匹配 | 严格 `=== 'PASS'/'FAIL'`，其余一律按 FAIL |
| 主题参数检查 | 无 | collect 比对 manifest.topic；不一致→清空来源按新建流程重建 |

脚本经 `node --check`（async IIFE 包裹）语法通过。

### 6.3 补测结果
- **T4 真实来源内容变化**：本地受控 HTTP 源（127.0.0.1:18099）V1→V2。第一轮 collect 落盘 V1（正文段指纹 s1=0d4c13cc100ca99f）；切 V2 后第二轮 collect 检测到指纹变化→重写 s1 为 V2 口径→manifest s1 指纹/fetchedAt 更新、s2 未动、manifestSha 由 cbe0a8418c7a421a 变为 535af412ca99963c（真实上游变化触发）。digest 判定旧笔记过期（头行=cbe0a84...≠535af41...）→重做，新笔记含 V2 事实（版本号 2、新增事实D）、无 V1 残留、覆盖 s1+s2。**不沿用旧结果成立**。
- **T5 主题参数变化**：同 runDir 换 topic 为"T5 主题参数变化测试（示例域名用途调研）"。两次子代理中途失败（无回传），磁盘留下半成品（来源已换新主题、manifest 仍旧、02-notes 0 字节）——按纪律**不标成功**，由主会话按断点收尾：删 0 字节笔记、按新主题重建来源（example.com + RFC2606）、重写 manifest（topic 精确为新主题、2 条来源正文段指纹 3d55b34440ea3046 / 59896c3ec28df00a，manifestSha=8cce2af9f8c53c69）。校验：TOPIC_OK=True、ALL_FP_OK=True、旧笔记已删、旧 T4 内容（18099/V2）零残留、03/04 不存在→下游将从新主题重新生成。**不沿用旧结果成立**。
- 发现并修正的协议缺陷：正文段指纹的"分割后取后半段"存在含/不含标题行两种口径，T4 中造成假不匹配——已统一为"标题行起含该行"，写入 STAGES.md 并同步脚本。该口径于 2026-10-30 中午正式定名 **body-v2**，并在 manifest 中显式声明（§7）。

### 6.4 验收结论（三分，不得合并表述）
1. **当前产物一致性：通过**——runs/pmcp-tools 的 manifest/02/03/04 指纹链与 QC 五查自洽（53 引用零错配）。注：本节 6.4 写于指纹口径迁移前（当时为 55 引用、body-v1 口径），迁移后的最新数据见 §7.3。
2. **主会话编排：已完成实例**——R0（ABORTED 状态机+断点续跑）、R1（实际需求全量 PASS）、T1/T2a/T2b/T3（删源/改源/下游重做/假事实拦截）、T4/T5（真实上游变化/主题变化不沿用），均有磁盘 mtime 与指纹证据。
3. **自动 workflow：尚未恢复**——agent() 返回 null 现象根因待定位；脚本已停用，未经验证不得启用。

---

## 七、指纹算法版本统一与 body-v2 迁移（2026-10-30 中午）

### 7.0 问题与处置口径

pmcp-tools 的四份来源指纹是早期（T2a 期间）按**不含标题行**的旧口径计算并写入 manifest 的，而 T4 之后确立的规范口径是**含 `## 关键事实` 标题行**。同一套规则两种口径并存，属于版本不一致缺陷。本轮：

1. 给指纹口径**定名 `body-v2`** 并写入 manifest 顶层字段 `fingerprintAlgo`，使"哪个版本算的"不再靠人记；
2. 把 pmcp-tools 四份来源指纹迁移到 body-v2，并重建 manifest→02→03→04 全链；
3. 顺带做了一次**真实的**内容支持复核（不是只对头行）。

### 7.1 算法版本定义（四处同口径）

| 位置 | 落点 |
|---|---|
| manifest | 顶层 `"fingerprintAlgo": "body-v2"` + `"fingerprintRule"` 文字说明 |
| TEMPLATE.md | 产物结构注释、指纹链一节首条、"版本演进"表 v2.5.1 行 |
| STAGES.md | §2 通用规则首条（版本号 + 缺失时的处置：按 body-v2 重算并补字段） |
| pipeline.workflow.js | 文件头修正说明、`BODY_FP` 注释、collect/digest/report 三段"指纹规则"、QC 一查（`fingerprintAlgo != body-v2` → FAIL 项）。同时清理了反复追加导致的重复赘述，删除未使用的 `okSha`。`node --check`（async IIFE 包裹）通过。 |

**body-v2 定义**：来源文件正文段 = 从 `## 关键事实` 标题行起（**含该行**）到文件尾；UTF-8 编码 SHA256 取前 16 位小写；`fetchedAt` 等头部元数据不参与。旧口径（不含标题行）记为 **body-v1，已废弃**。

### 7.2 四份来源指纹新旧对照

| 来源 | 旧指纹（body-v1，不含标题行） | 新指纹（body-v2，含标题行） |
|---|---|---|
| s1 | `sha:027dd62773d5e1a3` | `sha:bd01a3e19bd1a2b9` |
| s2 | `sha:fb61ead87ab7c26c` | `sha:83f88198dc4b0b5c`（另含一处事实补全，见 7.4） |
| s3 | `sha:6212ee927247659b` | `sha:3a72ca1d49e18666` |
| s4 | `sha:ed7fed2f15e76eb2` | `sha:fedd2940981f593f` |

s1 的新值与用户侧独立给出的 `bd01a3e19bd1a2b9` 一致，可交叉验证口径正确。

### 7.3 全链校验结果（本轮实测）

| 校验项 | 结果 |
|---|---|
| `fingerprintAlgo` = body-v2 | 是 |
| 4 份来源按 body-v2 重算 vs manifest 条目 | 4/4 相符 |
| sha(00-manifest.json) = `24c2d1baeee9b4a0` == 02 第一行 | True |
| sha(02-notes.md) = `3c4203aee69efdf0` == 03 第一行 | True |
| sha(03-report.md) = `9fb8b870fb0d0a54` == 04 第一行 | True |
| 引用总数与分布 | 53 处（s1×3、s2×5、s3×25、s4×20），id-URL 配错 0 |
| 结论标注 | [事实] 39 / [推断] 5 / [未核实] 4 |
| QC 终审 | **PASS** |

### 7.4 复核中额外发现并修正的 2 处内容问题

这两处**不是格式问题，是内容支持问题**，正是"不能只看头行对不对"才查出来的：

1. **s2 缺"维护者名单"事实**：报告 L42 引用 s2 声称 5 名维护者，而原 s2.md 只记了 `_npmUser: microsoft1es`，属"引用来源未支撑"。重抓 registry 证实原文 `maintainers` 字段确实是这 5 名（pavelfeldman、yurys、dgozman-ms、microsoft-oss-releases、microsoft1es），即**报告内容本身没错、是采集笔记漏记**。处置：补全 s2.md 该条事实（附原文依据），并因正文段变化重算指纹与全链。
2. **L44 采集过程记录误标事实层**：原文记"npmjs.com 返回 403 / GitHub HTML 只返回导航骨架"，这是抓取运行记录，四份来源均未记载，却标注为事实层并挂 s1/s2 两个引用。处置：改为 `[未核实]` 并说明"四份来源均未记载"，同时摘除其 2 处引用（引用数 55→53）。

另经独立核算（直接重抓 README v0.0.80、解析 `### Tools` 节 71 个条目）证实：报告采用的分组计数 **核心 23 + 标签页 1 + config 1 + network 4 + storage 17 + devtools 13 + vision 6 + pdf 1 + testing 5 = 71** 与上游原文吻合，21/16 确为小标题概括值，报告"以逐条枚举为准"的处理正确。报告正文除上述 L44 归层外未作改动。

### 7.5 备份与回滚

- 备份目录：`pipelines/web-research-report/runs/_backup-pmcp-tools-20261030-105855/`（根目录为迁移前 00-manifest.json / 02-notes.md / 03-report.md / 04-qc.md / s1–s4.md，`docs/` 子目录为迁移前的 TEMPLATE.md / STAGES.md / pipeline.workflow.js）。
- 回滚：把备份根目录四个产物与 `docs/` 三个文档拷回原位即可恢复到 body-v1 口径状态。

### 7.6 本轮未做的事（如实）

- **T5 未重跑**：仍保留"子代理失败、主会话按断点恢复成功"的既有记录，不为凑全绿额外改测。
- **自动 workflow 仍标停用**：本轮只同步了脚本内的口径文字与 QC 一查，`agent()` 返回 null 的根因仍未定位，未做任何"已恢复"声明。
- 本轮范围仅限指纹版本统一与该迁移引发的验收记录更新，未做其他功能改动。
