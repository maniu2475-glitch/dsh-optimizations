# 流水线阶段作业指导书（STAGES.md）v2.5.1

> 当前执行方式：**主会话直连编排**（每阶段派直连子代理，任务自包含；主会话 pwsh 磁盘校验后才放行下一阶段）。`pipeline.workflow.js` 已停用（根因待定位，恢复判据=warmup 对照实验通过），本文件作为阶段语义的人类文档与直连任务的蓝本。
> 实测依据：子代理有 pwsh 工具（Get-FileHash 可用）；最终回复必须纯 JSON，否则会被判违约。

## 通用规则（所有阶段必读）

1. 可用工具：read / glob / write / web_fetch / pwsh。pwsh 只用于哈希与文件检查，不做其它事。
2. **指纹规则（v2.5 语义修正，T1 实测得出）**：
   - **指纹算法版本 = body-v2**（manifest 顶层 `fingerprintAlgo` 必须为 `"body-v2"`；缺失或非 body-v2 → 按 body-v2 重算全部来源指纹并补写字段，02/03/04 头行随后按链重建）。来源文件（01-sources/sN.md）分两段：头部元数据段（`# 标题`/`url:`/`fetchedAt:` 行）与**正文段**（从 `## 关键事实` **标题行起（含该行）**到文件尾）。`manifest.sources[].fingerprint` 记录**正文段指纹**——fetchedAt 是元数据不参与指纹，重抓后正文事实未变 → 指纹不变 → manifest 不动；正文事实变了 → 指纹变 → 更新该条目 fingerprint 与 fetchedAt。
- **正文段指纹算法 body-v2（固定口径，全链统一）**：`$raw = Get-Content 'F' -Raw -Encoding UTF8; $body = ('## 关键事实' + ($raw -split '(?m)^## 关键事实', 2)[1]); $hex = (([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($body)) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0,16)`——即把标题行拼回分割结果再哈希。历史口径「不含标题行」为 body-v1，已废弃，不得再产出。
   - 整文件指纹（02/03/04 产物与指纹链校验用）：`(Get-FileHash 'F' -Algorithm SHA256).Hash.ToLower().Substring(0,16)`。
   - 相对路径基于会话 cwd；路径含空格要加引号。
3. **最终回复必须是且只能是一个 JSON 对象**——无 markdown 代码块标记、无前后说明文字。这是硬性要求。实测高频错误：任务的最后一步是算哈希时，模型容易把哈希值当最终回复发出（如 sha:7ec1...）而不是发 JSON——**算完哈希后必须继续发出约定的 JSON**。坏例：sha:7ec1056bcff6dd8c；好例：{"status":"done","issues":[]}。
4. 产物文件头部版本行格式（精确匹配，冒号后一个空格）：
   - 02-notes.md 第一行：`fingerprint: sha:<16位>`（= manifestSha）
   - 03-report.md 第一行：`notesFingerprint: sha:<16位>`（= sha(02-notes.md)）
   - 04-qc.md 第一行：`reportFingerprint: sha:<16位>`（= sha(03-report.md)）

## 阶段 1 · collect（调研收集）

输入：主题、种子URL（可空）。
产物：`01-sources/s1.md…sN.md` + `00-manifest.json`。

1. **续跑检查**：read `00-manifest.json`（不存在 → 跳到第 2 步新建）。
**主题参数一致性检查（v2.5.1）**：manifest.topic 与本次任务主题不一致 → 不得沿用旧产物：01-sources 全部清空、按新建流程重建，返回 `{"status":"repaired","issues":["主题参数变化，按全新运行重建"]}`。
   对 sources 里**每一个**条目：read 对应 sN.md 确认存在非空，并用 pwsh 重算其指纹与条目比对（一个不许跳过）。
   - 全部一致 → 返回 `{"status":"skipped","issues":[]}`，不要重抓。
   - 某文件缺失 → web_fetch 原URL重抓重写该 sN.md；重算指纹：
- 与条目一致 → **不动 manifest**（内容未变），返回 `{"status":"repaired","issues":["恢复sN：文件重建，正文指纹未变"]}`。
- 与条目不一致（上游内容变了）→ 更新该条目的 fingerprint 与 fetchedAt，重写 manifest，返回 `{"status":"repaired","issues":["更新sN：上游内容变化，正文指纹已更新"]}`。
   - 某文件存在但内容为空 → 同缺失处理。
2. **新建**：用 web_fetch 抓取 2-4 个权威来源（官方文档/官方GitHub 优先；种子失效就换同主题权威来源并记入 issues）。每个来源写 `01-sources/sN.md`（N 从 1 连续）：
   ```
   # <来源标题>
   url: <URL>
   fetchedAt: <ISO时间>
   ## 关键事实
   - <事实1>（原文依据：<关键句原文片段>）
   - <事实2>（原文依据：...）
   - <事实3>（原文依据：...）
   ```
   写完用 pwsh 算每个文件的指纹，然后写 `00-manifest.json`：
   ```json
   {"topic":"<主题>","createdAt":"<ISO>","sources":[{"id":"s1","url":"...","title":"...","fetchedAt":"...","fingerprint":"sha:<16位>"}]}
   ```
   返回 `{"status":"done","issues":[]}`。

## 阶段 2 · digest（综合笔记）

1. read `00-manifest.json`；对 sources 里**每一个** sN.md：read 非空 + pwsh 重算指纹与条目一致（一个不许跳过）。任一不一致 → 返回 `{"status":"stale"}`。
2. 算 manifestSha。read `02-notes.md`（不存在 → 第 3 步）。第一行 `fingerprint: <manifestSha>` 且正文为结构化发现清单（分组、每条带 [来源sN]、覆盖全部来源）→ 返回 `{"status":"skipped","findings":<正文发现条数>}`，不要重写。
3. 否则写 `02-notes.md`：第一行 `fingerprint: <manifestSha>`；正文按主题分组的发现清单，每条末尾 `[来源sN]`，必须覆盖全部来源文件。写完算 sha(02-notes.md)。
4. 返回 `{"status":"done","findings":<条数>}`。

## 阶段 3 · report（报告）

1. read 02-notes.md（第一行 fingerprint=manifestSha）与 00-manifest.json；用 pwsh 核对 02 第一行 == sha(00-manifest.json)、抽验每个 sN 指纹与 manifest 一致。任一不符 → 返回 `{"status":"stale"}`。
2. 算 notesFingerprint=sha(02-notes.md)。read `03-report.md`（不存在 → 第 3 步）。第一行 `notesFingerprint: <当前值>`、正文结构合格、且本消息无【修复指令】→ 返回 `{"status":"skipped","citations":<正文引用条数>}`，不要重写。
   本消息含【修复指令】→ **忽略跳过规则**，按修复指令重写全文。
3. 否则写 `03-report.md`：第一行 `notesFingerprint: <当前值>`；结构化中文报告（概述/核心发现/细节/结论）。**每个结论标注三层之一**：
   - `[事实]`——来源原文直接支持，附引用 `[来源N](url)`
   - `[推断]`——写明由哪些事实经什么推理链得出
   - `[未核实]`——无法从来源确认，说明原因
   只引用 manifest 里真实存在的 URL。
4. 返回 `{"status":"done","citations":<引用条数>}`。

## 阶段 4 · qc（引用与产物检查，独立复核者）

对运行目录执行五查（全部完成后再写 04-qc.md）：
1. **清单完整性**：read manifest；glob `01-sources/*.md`；条目数=文件数、id 连续（s1..sN）、每个文件 read 非空、pwsh 重算每个文件指纹与 manifest 条目一致（一个不许跳过）。
2. **指纹链**：sha(00-manifest.json) == 02 第一行；sha(02-notes.md) == 03 第一行；sha(03-report.md) == 04 第一行（若 04 已存在则注明是旧文件）。
3. **引用一致性**：读 03-report.md 全部 `[来源N](url)`，对照 manifest（编号与 URL 都要一致），计数。
4. **内容支持检查**：对每个 `[事实]` 结论，在来源文件原文中找到直接支持片段；找不到 → FAIL 项。`[推断]` 检查推理链是否写明；`[未核实]` 检查是否确实无法核实。
5. **重抓抽样**：web_fetch 抽 1-2 个 URL，核对返回内容与对应 sN.md 关键事实不矛盾（不可达 → 如实记录，不判 FAIL）。

写 `04-qc.md`：第一行 `reportFingerprint: sha:<sha(03-report.md) 的16位>`（必须带 `sha:` 前缀），然后五查全表 + 总体判定 **PASS** 或 **FAIL**。
返回 `{"verdict":"PASS"或"FAIL","issues":[<每个FAIL项，含编号与证据>],"citationsChecked":<n>,"filesChecked":<n>}`。
