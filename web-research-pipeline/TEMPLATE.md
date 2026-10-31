# 模板：网页调研 → 保存来源 → 生成报告 → 检查引用与产物

版本：2.5.1（2026-10-30）。**当前执行方式：主会话直连编排**——主会话按阶段顺序派发直连子代理（自包含任务），每阶段后主会话用 pwsh 做磁盘校验（指纹链、清单、头行比对全部由主会话复算），校验不过不放行下一阶段。`pipeline.workflow.js` **已停用**（见"执行方式"与"workflow 脚本停用说明"）。

## 执行方式（唯一现行方式）

1. 主会话按 collect→digest→report→qc 顺序给子代理发自包含任务（任务全文内嵌指纹规则、流程步骤、返回契约；代理不自读 STAGES.md——v2.2/2.3 实测自读模式更差，STAGES.md 为人类文档）。
2. 每阶段代理结束后主会话立即 pwsh 磁盘校验：产物存在/非空、头行指纹复算匹配、来源覆盖。校验不过不放行。
3. 阶段代理失败/产物不合规 → 主会话重派该阶段（磁盘断点保证不重做已完成阶段）。
4. QC FAIL → 主会话把 issues 转成【修复指令】派 report 重写 → 复查（最多一轮）；复查仍 FAIL → 不标成功。
5. 混沌注入（chaos）当前仅主会话手工模拟（编排层注入 null）。

## workflow 脚本停用说明

- 现状：本会话（2026-10-30 凌晨）实测 workflow 工具的 agent() 连「直接返回 {"status":"ok"}」的 warmup 任务都返回 null，同任务直连 subagent 正常。**根因未定位**（可能因素：本会话模型切换历史、引擎结果回传/校验管线、会话内状态；均未证实），暂记待定位，不定性为引擎故障。
- 处置：自动 workflow 编排**尚未恢复**，修复前不用于本流水线；恢复判据 = 先跑 warmup 对照实验（workflow 单 agent 极简 JSON 任务 vs 直连 subagent 同任务），对照通过才可重新启用。不写"引擎修复即可用"。
- v2.5.1 同步修正：`pipeline.workflow.js` 已按现行协议修正（正文段指纹口径、修复意见真实注入、严格 PASS/FAIL 判定、主题参数一致性检查），修正≠恢复可用。
- 主会话直连编排完整实例：runs/t-r0-null（R0）、runs/pmcp-tools（R1+T1/T2/T3）、runs/t4-t5-*（T4/T5 补测，见验收报告）。

## v2.x 演进与实证决策（8 次运行换来的）

| 版本 | 设计 | 实证结果 |
|---|---|---|
| v1 | 4 阶段自包含 prompt，返回值带引用数 | 全量跑通+断点续跑 PASS；collect/report 偶发返回违约 |
| v2 | + manifest 全量校验 / SHA256 指纹链 / 结论三层标注 / 状态机 | **含哈希字段的返回 schema 违约率极高**（模型算完哈希把值当回复发；6 次运行 5 次违约，产物本身完美落盘） |
| v2.2/2.3 | STAGES.md 自读 + 极简探针 | 自读模式反而更差；探针也违约 |
| v2.4 | 自包含 prompt + 返回 schema 零哈希字段 + chaos 钩子 + QC 修复回路 | 见验收报告 |
| v2.5 | 指纹口径=来源正文段（fetchedAt 不参与）+ 主会话直连编排 | T1 缺陷修正；R0/R1/T1/T2/T3 全过 |
| v2.5.1 | 指纹算法版本固定为 **body-v2**（标题行起含该行）；workflow 脚本同步修正但标停用；入口统一主会话直连；结论三分 | 补测 T4/T5 见验收报告 v2.5.1 章节；pmcp-tools 已迁移到 body-v2 |

**硬规则（实证得出，勿回退）**：
1. 阶段返回 schema 只允许 status/verdict/findings/citations/issues 等简单字段——**绝不含哈希/指纹字段**。
2. 指纹的产出（写进文件头部）与验证（QC 五查全量复算）都在代理内部完成；编排层只信 status/verdict 枚举白名单与 ABORT 守卫。
3. 阶段 null → ABORTED，不标成功；原参数重跑 = 从磁盘断点续跑（产物存在即跳过）。
4. 成功标记只由 QC 终审给出（五查：清单完整/指纹链/引用一致/内容支持/重抓抽样）。
5. **主题参数一致性检查**（v2.5.1 增补）：manifest.topic ≠ 本次运行 topic → 不得沿用旧产物，按全新目录处理。

## 输入

- `topic`：调研主题（必填）
- `runDir`：运行目录（必填，如 `pipelines/web-research-report/runs/<slug>/`）
- `seedUrls`：种子来源 URL 列表（可选）
- `chaos`：验收专用钩子（collect-null / digest-null / report-null / qc-null）——当前仅主会话手工模拟

## 目录与产物

```
runDir/
 00-manifest.json # {fingerprintAlgo:"body-v2", topic, createdAt, sources:[{id,url,title,fetchedAt,fingerprint}]}；fingerprint=来源正文段指纹（body-v2）
 01-sources/s1.md… # 头部元数据（# 标题/url:/fetchedAt:）+ ## 关键事实（≥3条+原文依据）
 02-notes.md # 第一行 fingerprint: sha:<manifestSha>；分组发现清单
 03-report.md # 第一行 notesFingerprint: sha:<sha(02)>；结论逐条 [事实]/[推断]/[未核实]
 04-qc.md # 第一行 reportFingerprint: sha:<sha(03)>；五查全表 + PASS/FAIL
```

## 指纹链（上游变化 → 下游重生成）

- 00-manifest.json 是来源真源；02 头行 = sha(manifest)；03 头行 = sha(02)；04 头行 = sha(03)。
- **指纹算法版本 = `body-v2`**（manifest 顶层 `fingerprintAlgo` 字段显式标注，模板/阶段说明/校验逻辑/脚本四处同口径；缺失或非 body-v2 的 manifest 按 body-v2 重算并补字段）。
- 来源指纹口径（body-v2）：**正文段指纹**——从 `## 关键事实` **标题行起（含该行）**到文件尾算 UTF-8 SHA256 取前16位小写；fetchedAt 等头部元数据不参与；重抓后正文事实未变 → 指纹不变 → manifest 不动（下游不连锁）；正文事实变了 → 指纹变 → 更新该条目 → manifestSha 变 → 下游头行比对失败 → 自动重做。

## 状态机

- 任何阶段 null/schema 违约 → ABORTED（磁盘无半成功标记）；重跑即续。
- QC FAIL → issues 转【修复指令】给 report → 复查；复查仍 FAIL → 不标成功（FAIL_AFTER_REPAIR）。
- 阶段 status 白名单：done/skipped/repaired（collect）；done/skipped（其余）；stale 一律按过期处理。
- 主题参数检查（v2.5.1）：重跑时 manifest.topic ≠ 本次 topic → 不得沿用旧产物（重派 collect 重建）。

## 预期结论三分（验收表述规范）

1. **当前产物一致性通过**：runs/pmcp-tools 产物指纹链与 QC 五查在 v2.5 协议下自洽。
2. **主会话编排已完成实例**：R0/R1/T1/T2/T3 为直连编排的完成实例（证据=磁盘 mtime 链+QC 记录）。
3. **自动 workflow 尚未恢复**：pipeline.workflow.js 已修正但标停用；根因待定位（warmup 对照实验通过前不得启用）。

## 验收测试矩阵

| 测试 | 操作 | 预期 |
|---|---|---|
| R0-null | chaos=digest-null | ABORTED@digest，不标成功；重跑（无 chaos）从 notes 续起 |
| R1 | 实际需求全量跑 | PASS，4 类产物齐全 |
| T1 | 删一个来源文件后重跑 | collect=repaired（重建），digest 起重算，QC PASS |
| T2a | 改一份来源内容后重跑 | collect=repaired（上游变化），manifest 指纹更新 |
| T2b | T2a 后重跑 | digest/report 头行指纹过期 → 重做（时间戳证明） |
| T3 | 报告注入错误结论后重跑 | QC 内容支持检查 FAIL → 修复回路 → PASS |
| T4 | 真实来源内容变化（受控 HTTP 源 V1→V2） | collect 检测→manifest 更新→digest 不沿用旧结果（report 同链路由 T2b 覆盖） |
| T5 | 同 runDir 换 topic 重跑 | manifest 主题不一致→重建，不沿用旧结果 |
