## Primary Request and Intent
- Base project: DSH self-optimization per `outputs/DSH-下一阶段目标与验收.md`. Phase 1 (config persistence / model transparency / project memory) and Phase 2 (browser ops) are closed.
- Just completed: fix the last fingerprint-version inconsistency. Migration of `runs/pmcp-tools` from body-v1 (no title line) to `body-v2` (title line included) is DONE and accepted.
- **CURRENT ACTIVE REQUEST (verbatim essentials)**: "完成当前指纹迁移后，请新增一项独立优化：学习 Codex、Claude Code 等成熟 Agent 的公开上下文管理设计，改进 DSH 的自动上下文压缩。目标：长任务能持续执行，降低上下文占用，同时保留关键约束、工作状态和证据，避免压缩后遗忘、重复操作或任务漂移。"
  - 一、先查本机现状：检查已有 compaction、工具结果裁剪、会话恢复机制与实际配置；说明哪些已启用、如何触发、摘要保存位置、下一轮请求如何使用。**优先扩展已有机制，避免重复安装**。调研只参考公开官方文档与开源实现；区分通用设计与特定模型/API 专属能力；不假定 <代理产品名> 支持 OpenAI 服务端压缩接口。
  - 二、9 项实现要求：(1) 按上下文 token 预算触发，预算含系统指令+工具定义+历史+预留输出，不按消息条数；拿不到准确 token 数须注明估算方法；(2) 分层——先裁重复/冗长旧工具输出，再压缩较早历史，保留最近必要的完整对话与工具往返；(3) 摘要固定保留：当前目标、用户最新要求原话与关键约束、已完成及验证结果、未完成事项、文件与产物位置、关键决策及依据、失败尝试、待解决问题与下一步；(4) 区分事实/推测/未验证；保留"新要求替代旧要求"关系，不把旧决定当当前要求；(5) 大日志/来源正文/大产物存磁盘，摘要只留结论与可找回位置；保留原始会话，不用摘要覆盖唯一记录；(6) 不拆散未完成工具调用与结果、不丢调用编号；压缩后不得重复执行已完成的修改/提交/发送；(7) 压缩成功并校验后才切换，失败保留原状态、有限重试并明确报告；避免刚压缩完又连续触发；(8) 项目长期记忆与会话压缩分开管理，不把临时推测写成长期事实；(9) 记录触发原因、压缩前后 token 数或估算值、耗时、摘要位置、恢复结果，提供手动压缩与回滚方式。
  - 三、真实验收（受控低阈值，避免制造大量付费上下文）：手动压缩后继续原任务不丢关键约束与已验证结果；自动触发后继续执行不重复已完成操作；用户中途改要求后压缩须遵守新要求；工具调用边界、压缩失败、重启恢复均有测试记录。
  - 交付：实际配置、使用说明、测试证据、限制。"仅增加提示词、生成摘要文件，不能算自动压缩功能完成；也不要把压缩成功等同于 <代理产品名> 通道校验通过。"

## Key Technical Concepts
- DSH 0.2.1-rc.3; workspace `<本机路径>`. Real install root is D: drive: `<本机路径> Harness\resources\app.asar` (182,434,783 B; `app.asar.unpacked` exists but holds no package sources).
- asar source extraction: read `UInt32LE` at offset 12 for header size, JSON header at offset 16, `baseOffset = 16 + headerSize - 8`; walk `header.files` for `{path, offset, size}`.
- Session log: `~/.dsh/sessions/<sanitized-cwd>/<sessionId>/session.v4.jsonl.zstd` — **concatenated zstd frames**; split on magic `28 B5 2F FD`, decompress each with `zlib.zstdDecompressSync`.
- Compaction is a 4-plugin stack: token-meter (measurement) → tool-result-pruner (trim) → compaction-basic (engine) → command-compact (`/compact`).
- Threshold formula (source `compaction-basic/lib/index.js` L129–135): `messageBudgetTokens = contextWindow − reservedCompletionTokens`; `pressureBudgetTokens = messageBudgetTokens − headroomTokens`; `thresholdTokens = floor(min(contextWindow × thresholdRatio, pressureBudgetTokens))`; `retainTokens = floor(messageBudgetTokens × retainRatio)`.
- Defaults (`DEFAULT_THRESHOLD_RATIO = .8`, `DEFAULT_RETAIN_RATIO = .16`, headroom `65536`, `compactionRetries = 1`, `maxOverflowRetries = 1`).
- Durable event sequence per compaction: `compaction/start` → `compaction/summary` → `user/message` with `source.kind = "compact-checkpoint"` + `surfaceOp {op:'replace', startSeq, endSeq}` → `compaction/end`. Original events preserved; `sourceEventSeqs` lists shadowed seqs.
- Token estimation (`token-meter/lib/types/estimate.js`): `CHARS_PER_TOKEN = 4`, `BLOCK_OVERHEAD = 4`, `ROLE_OVERHEAD = 4`; tools priced `ceil(JSON.stringify(tools).length / 4) + 4`. Package README admits the heuristic **undercounts CJK and JSON Schema**.
- `BasicCompactionEngine` is exported; `summarize(input, agent, signal)` is the sole override hook ("Override this sole hook for a template or remote summarizer"). `COMPACTION_INSTRUCTION` and `frameSummary()`/`CHECKPOINT_PREAMBLE` are module-internal.
- Local plugin package precedent: `@local/dsh-personal-presets` via `"link:<本机路径>/Documents/deepseek-harness/default-workspace/personal-presets-bundle"` in profile `package.json` `dependencies` + `dsh.profile.bundles`.
- Context-management concepts (from user's requirement set, to be corroborated by research): token-budget triggering, layered trimming, fixed summary schema, fact/inference/unverified layering, requirement supersession, disk spill + pointers, tool-pair atomicity, transaction-then-verify-then-switch, bounded retries, separate long-term memory.

## Files and Code
- `docs/DSH-上下文管理现状核查.md` — **newly created**, full current-state audit: plugin enable status table, trigger paths, threshold math with real numbers, summary storage/lifecycle, 4 real compaction records, summary template structure, token estimation method, 9-requirement gap table, limitations.
- `~/.dsh/profiles/desktop/cordis.yml` (1693 lines, 64142 B) — top-level L316-323: `token-meter` enabled, `compaction-basic` `disabled: true`, `command-compact` `disabled: true`; L372-378 `tool-result-pruner` `disabled: true` + `thresholdChars: 8192 / headChars: 4096 / tailChars: 1024`; L364-369 `spill-local` + `spill-policy maxInlineTokens: 12500`; L379-380 `image-offload` enabled. **Preset `standard` is default (L674 `default: standard`)**; `preset-standard` at L675; its internal `compaction` group at L776-792 has NO `disabled` and mounts all three plugins — this is what actually runs.
- `~/.dsh/profiles/desktop/cordis.patch.yml` (3444 B) — adds `llm-pi-ai` provider `wb-proxy` (`baseURL: http://<本地代理地址>/v1`, `defaultMaxTokens: 8192`, `maxTokensField: max_tokens`), `agent-default-model` = `wb-proxy/deepseek-v4.1-flash`, and round4 browser-use inserts. Supports `!!js` expressions and `insert:` lists.
- `~/.dsh/profiles/desktop/package.json` — `dependencies` incl. `@local/dsh-personal-presets`; `dsh.profile.bundles` = `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@local/dsh-personal-presets`.
- `personal-presets-bundle/package.json` — 152 B minimal local bundle: `{"name":"@local/dsh-personal-presets","version":"1.0.0","private":true,"type":"module","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}`.
- `<本机路径>` — backup of `cordis.yml`, `cordis.patch.yml`, `package.json` taken before any modification.
- Extracted reference sources in `%TEMP%\dsh-src\`: `compaction-basic.README.zh.md` (20310 B), `compaction-basic.index.js` (49452 B), `token-meter.README.zh.md`, `token-meter.estimate.js`, `command-compact.README.zh.md`, `command-compact.index.js`, `pruner.README.zh.md`, `pruner.index.js`.
- Helper scripts in `%TEMP%`: `asar-list.js`, `asar-get.js`, `read-zstd2.js`, `read-comp.js`, `read-hdr.js`, `read-repl.js`, `sum-audit.js`.
- Pipeline files (completed prior work, unchanged this turn): `pipelines/web-research-report/TEMPLATE.md`, `STAGES.md`, `pipeline.workflow.js` (all mention `body-v2`, script still marked 已停用), `runs/pmcp-tools/*`.
- `docs/DSH-流水线v2.5验收报告.md` — has new §七 documenting body-v2 migration, §7.2 old→new fingerprint table, §7.3 chain results, §7.4 two content fixes, §7.5 backup/rollback, §7.6 explicitly-not-done list.
- `AGENTS.local.md` — M5 entry updated with `body-v2`; new 陷阱 bullet about caliber versioning (line 22).
- `~/.dsh/memory/default-workspace/pipeline-web-research.md` — L14 body-v2 caliber, L21 post-migration R1 stats, L22 migration record.

## Errors and Fixes
- PowerShell path failures: profile package dir lives on D: while `$env:LOCALAPPDATA` resolves to C: → `Test-Path` returned False. Fixed by using the literal D: path.
- 64 KB+ `cordis.yml` appeared contradictory (top-level `disabled: true` vs preset-internal enabled) → resolved by reading L776-792: preset group wins; top-level entries are separate standalone mount slots. Documented as the easiest misread in this config.
- `zstdDecompressSync` on the whole file returned only 1 event → file is 2249 concatenated frames; fixed by splitting on magic bytes.
- `PSCustomObject` typing errors: `+= ,@(...)` on `$factLines` threw "op_Addition"; fixed with `System.Collections.ArrayList`.
- `$lines | for($i...)` pipe after `for` → "An empty pipe element is not allowed"; fixed with a pre-built ArrayList.
- A variable named `$start` behaved as an automatic variable (matched line 0); renamed to `$toolsIdx`.
- `if` used as an expression inside a string concatenation in PowerShell → "无法将'if'项识别为 cmdlet"; harmless, dropped.
- Label self-reference: writing the literal token `[事实]` inside an explanatory sentence made regex counts treat it as a tag; reworded to "按'未核实'层标注而非事实层". Final counts: [事实] 39 / [推断] 5 / [未核实] 4, citations 53.

## Pending Jobs
- Complete research on public Codex / Claude Code / Cursor / Gemini CLI / Aider context-management designs. Subagent `fe46122c-ecb5-4b44-a59b-d27851821740` ("调研上下文管理公开设计") is **still running**; it must return sections A (point table with `[原文] URL` / `[未核实]`), B (general vs vendor-specific table), C (top-5 designs), D (unverified items), ≤1500 chars, no files written.
- Decide and implement improvements for the three identified gaps (G1/G2/G3 below) without modifying install files.
- Run the four controlled acceptance tests with a **low threshold** (avoid large paid context).
- Deliver config, usage instructions, test evidence, and limitations.

## Current Work
- Current-state audit is COMPLETE with hard evidence:
  - Current session `<会话ID>` log is 4.19 MB; 4385 events; **4 real compactions**: `ea1f5c78…` (auto, turn 18, replace seq 17–833), `5c4c1c0d…` (auto, turn 30, seq 1142–1831), `218ac054…` (auto, turn 33, seq 2187–2337), `94f31fcd…` (**manual `/compact`**, `sourceCommandId: cmd-e99bb5e5-2`, `turn: null`, seq 3062–3778). Plus **19 `compaction/prune`** events (e.g. seq 903 pruned 2795 tokens; seq 905 pruned 12491 tokens).
  - Runtime values: `contextWindow = 262144`, `maxTokens = none` (O = 0), headroom 65536 → **threshold 196608**, **retain 41943**.
  - Summary template fixed 8 sections: `Primary Request and Intent` / `Key Technical Concepts` / `Files and Code` / `Errors and Fixes` / `Pending Jobs` / `Current Work` / `Next Step` / `Critical Context`; wrapped in `<compacted-summary>` tags with a fixed English checkpoint preamble.
  - Audit of the 4 real summaries: summary #1 (11600 chars) and #2 (14855) **missing fact/inference layering**; #4 (11080) **missing requirement-supersession**; all 4 lack a dedicated "已完成并验证的结果" / "失败尝试" field (content sometimes present incidentally).
- Gap table produced (9 requirements): 1,2,5,7,8 satisfied; 3,6 partially; 4 not satisfied; 9 partially. Distilled to three actionable gaps:
  - **G1**: template lacks explicit "完成的并已验证结果" and "失败尝试" fields → risk of repeating completed operations.
  - **G2**: template lacks fact/inference/unverified layering and "new requirement supersedes old" relation → task drift / stale decisions reviving.
  - **G3**: no reachability self-check, no documented rollback, no user-visible failure reporting.
- Conclusion reached: the feature already exists and works; the task is verify-and-improve, not build-from-scratch. Summary instruction text is hardcoded in `app.asar` (`COMPACTION_INSTRUCTION`), so it must NOT be edited; the sanctioned extension point is subclassing `BasicCompactionEngine` and overriding `summarize()`, shipped as a local plugin package via `link:` + patch-layer insert.
- Backup taken at `~/.dsh/backups/context-mgmt-20261030-111629\`. No configuration has been modified yet.

## Next Step
- Collect the research subagent's result (`fe46122c-ecb5-4b44-a59b-d27851821740`), then finalize the improvement plan: build a local plugin package (e.g. `context-compaction-bundle/`) exporting a `BasicCompactionEngine` subclass that overrides `summarize()` with an upgraded instruction covering G1/G2 fields, wire it via profile `package.json` `link:` dependency + `cordis.patch.yml` insert, and verify with a low-threshold controlled run.

## Critical Context
- Constraints: never restart user clients including DSH; no shared-proxy (<本地代理地址>) config changes; approvals are auto-rejected (never set `sandbox_permissions`); never print credential values; leave Codex/Trae-CN configs untouched; do not modify program install files (`app.asar`); evidence must be verbatim (timestamps, hashes) distinguishing 已执行 / 已验证 / 推测.
- Cannot rely on preset-internal config being patchable by id — must verify patch-layer targeting of the preset's compaction group before assuming `config:` overrides propagate.
- Acceptance must use a controlled low threshold to limit paid context; do not equate compact success with WB-proxy channel health (log shows an upstream 403/11128 incident at turn 37 caused by long payloads; `kimi-k3.1-pro` was recommended for long payloads).
- Delivery must explicitly state that prompt-only or summary-file-only changes do NOT count as a working automatic compaction feature.
- Prior pipeline state (do not disturb): pmcp-tools final chain `manifestSha 24c2d1baeee9b4a0` → `sha02 3c4203aee69efdf0` → `sha03 9fb8b870fb0d0a54`; sources s1 `bd01a3e19bd1a2b9`, s2 `83f88198dc4b0b5c`, s3 `3a72ca1d49e18666`, s4 `fedd2940981f593f`; QC PASS; 53 citations; backup at `pipelines/web-research-report/runs/_backup-pmcp-tools-20261030-105855/`.
- T5 deliberately remains "agent failed, manual recovery succeeded" — no rerun. Automatic workflow stays 停用 (`agent()` returning null is 待定位, not declared an engine fault).
- `token-meter` is enabled but CJK undercount means real triggering happens earlier than the numeric threshold.
- Compaction cannot shrink system prompt, tool definitions, or session prefix, and cannot split a single oversized unit.