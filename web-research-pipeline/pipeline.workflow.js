// ⛔ 已停用（v2.5.1, 2026-10-30）：DSH workflow 工具的 agent() 在本会话实测对极简任务也返回 null
// （同任务直连 subagent 正常），根因未定位、暂记待定位。自动 workflow 编排尚未恢复。
// 恢复判据：先跑 warmup 对照实验（本脚本单 agent 极简 JSON 任务 vs 直连 subagent 同任务），
// 对照通过才可重新启用。当前唯一执行方式 = 主会话直连编排（见 TEMPLATE.md）。
//
// 本文件已按 v2.5.1 协议同步修正（修正≠恢复可用）：
// 1) 指纹口径=指纹算法版本 body-v2：来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与）；
// 2) QC FAIL 的 issues 真实注入 report 修复任务的【修复指令】；
// 3) 严格 PASS/FAIL 判定（verdict 必须 === 'PASS'/'FAIL'，不再 includes('PASS') 宽容匹配）；
// 4) collect 增加主题参数一致性检查（manifest.topic ≠ args.topic → 重建，不沿用旧产物）。
// 网页调研流水线 v2.5.1 编排骨架（已停用，见文件头）
// v2.4 实证定版：自包含详细 prompt（v1 风格，digest/report/qc 曾 100% 通过的形态）
//            + 无哈希 schema（v2.3 决策：含哈希字段的 schema 违约率高，哈希只留在代理内部逻辑与 QC 终审）
//            + chaos 钩子 + 修复回路。STAGES.md 降级为人类文档（代理不再自读）。
// chaos: collect-null | digest-null | report-null | qc-null
const topic = args.topic
const runDir = args.runDir
const seeds = (args.seedUrls || []).map(String)
const chaos = args.chaos || ''
const JSON_ONLY = '你的最终回复必须是且只能是一个 JSON 对象（无代码块标记、无前后文字、无额外说明）。算完哈希后也要继续发 JSON，绝不把哈希值本身当回复。'
// 指纹算法版本 body-v2（唯一现行口径，manifest.fingerprintAlgo 必须为 body-v2）：来源指纹=来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与）；02/03/04 头行=整文件指纹
const BODY_FP = (rel) => `pwsh: $raw = Get-Content '${rel}' -Raw -Encoding UTF8; $body = ('## 关键事实' + ($raw -split '(?m)^## 关键事实',2)[1]); $hex = (([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($body)) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0,16)`
const abort = (stage, reason) => ({ result: 'ABORTED', stage, reason, topic, runDir })

phase('collect')
let collect = chaos === 'collect-null' ? null : await agent(
  `你是流水线阶段1（调研收集）。运行目录：${runDir}（相对会话 cwd）。
指纹规则（算法版本 body-v2）：来源指纹=来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与）；02/03/04 头行指纹=整文件指纹 pwsh (Get-FileHash 'F' -Algorithm SHA256).Hash.ToLower().Substring(0,16)。manifest 必须带 "fingerprintAlgo":"body-v2"；读到缺失或非 body-v2 的 manifest → 按 body-v2 重算全部来源指纹、补写该字段并重写 manifest（返回 {"status":"repaired","issues":["指纹口径迁移到 body-v2"]}），02/03/04 头行随后按链重建。指纹只用于写进文件与内部比对，**绝不出现在你的最终回复里**。manifest.sources[].fingerprint 一律为 body-v2 口径。
${seeds.length ? '种子URL：\n' + seeds.join('\n') : '无种子URL：用 web_fetch 自行检索最权威来源（官方文档/官方GitHub 优先）。'}
流程：
1. 若 ${runDir}/00-manifest.json 存在：先核对 manifest.topic 与本任务主题一致（不一致 → 把 01-sources 全部清空重建，按第 2 步新建流程走，返回 {"status":"repaired","issues":["主题参数变化，按全新运行重建"]}）。
2. 对 manifest.sources 里每一个条目（每个都查，不许只查第一个）：read 对应 01-sources/sN.md 确认非空，pwsh 按 body-v2 口径（来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与））重算指纹与条目比对。
   全部一致 → 返回 {"status":"skipped","issues":[]}，不要重抓。
   某文件缺失或为空 → web_fetch 原URL重抓重写该 sN.md，pwsh 按 body-v2 口径重算指纹：与条目一致 → 不动 manifest，返回 {"status":"repaired","issues":["恢复sN：文件重建，正文指纹未变"]}；不一致 → 更新该条目 fingerprint 与 fetchedAt 并重写 manifest，返回 {"status":"repaired","issues":["更新sN：上游内容变化，正文指纹<旧>→<新>"]}。
3. 若 manifest 不存在：web_fetch 抓 2-4 个权威来源（种子失效就换同主题权威来源并记入 issues），每个写 ${runDir}/01-sources/sN.md（N 从1连续）：
   第一行 "# <来源标题>"，然后 "url: <URL>"、"fetchedAt: <ISO>"、"## 关键事实" 与至少3条事实（每条附"（原文依据：<片段>）"）。
   写完 pwsh 按 body-v2 口径（来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与））算每个文件指纹，写 ${runDir}/00-manifest.json：{"fingerprintAlgo":"body-v2","topic":"<本任务主题原文>","createdAt":"<ISO>","sources":[{"id":"s1","url":"...","title":"...","fetchedAt":"...","fingerprint":"sha:..."}]}（覆盖全部 sN 文件）。
   返回 {"status":"done","issues":[]}。
${JSON_ONLY}`,
  { label: 'collect', schema: { type: 'object', properties: { status: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } } }, required: ['status'] } }
)
if (!collect) return abort('collect', '阶段返回null或schema违约（原参数重跑即从磁盘断点续）')
if (!['done', 'skipped', 'repaired'].includes(collect.status)) return abort('collect', 'status非法: ' + collect.status)
log('collect: ' + collect.status + (collect.issues && collect.issues.length ? '；' + collect.issues.join('；') : ''))

phase('digest')
let digest = chaos === 'digest-null' ? null : await agent(
  `你是流水线阶段2（综合笔记）。运行目录：${runDir}（相对会话 cwd）。
指纹规则（算法版本 body-v2）：02/03/04 头行指纹=整文件指纹 pwsh (Get-FileHash 'F' -Algorithm SHA256).Hash.ToLower().Substring(0,16)；来源文件比对用 body-v2 口径（来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与））。指纹只用于写进文件与内部比对，**绝不出现在你的最终回复里**。
流程：
1. read ${runDir}/00-manifest.json；若 manifest.topic 与本任务主题不一致 → 返回 {"status":"stale"}（主题参数变化，上游将重建）。
2. 对 manifest.sources 里每一个 sN.md（每个都查）：read 非空 + pwsh 按 body-v2 口径（来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与））重算指纹与条目一致。任一不一致 → 返回 {"status":"stale"}。
3. 算 manifestSha。read ${runDir}/02-notes.md（若存在）：第一行 "fingerprint: <manifestSha>" 且正文为结构化发现清单（有分组、每条带 [来源sN]、覆盖全部来源）→ 返回 {"status":"skipped","findings":<正文发现条数>}，不要重写。
4. 否则写 ${runDir}/02-notes.md：第一行 "fingerprint: <manifestSha>"；正文按主题分组的发现清单，每条末尾 [来源sN]，覆盖全部来源。写完算 sha(02-notes.md) 备用。
5. 返回 {"status":"done","findings":<条数>}。
${JSON_ONLY}`,
  { label: 'digest', schema: { type: 'object', properties: { status: { type: 'string' }, findings: { type: 'number' } }, required: ['status'] } }
)
if (!digest) return abort('digest', '阶段返回null或schema违约（原参数重跑即从磁盘断点续）')
if (!['done', 'skipped'].includes(digest.status)) return abort('digest', 'status非法或来源过期: ' + digest.status)
log('digest: ' + digest.status + (digest.findings != null ? '，发现 ' + digest.findings + ' 条' : ''))

phase('report')
let repairNote = ''
const repairHistory = []
let report = null
let qc = null
for (let attempt = 1; attempt <= 2; attempt++) {
const repairBlock = attempt > 1 && repairNote ? ('【修复指令】上一轮 QC 未通过，以下问题必须全部修复（忽略 03-report.md 的跳过规则，重写全文）：\n' + repairNote + '\n' + '【修复指令结束】\n') : ''
  report = chaos === 'report-null' ? null : await agent(
    `你是流水线阶段3（报告）。运行目录：${runDir}（相对会话 cwd）。
指纹规则（算法版本 body-v2）：02/03/04 头行指纹=整文件指纹 pwsh (Get-FileHash 'F' -Algorithm SHA256).Hash.ToLower().Substring(0,16)；来源文件比对用 body-v2 口径（来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与））。指纹只用于写进文件与内部比对，**绝不出现在你的最终回复里**。
流程：
1. read ${runDir}/00-manifest.json；若 manifest.topic 与本任务主题不一致 → 返回 {"status":"stale"}。
2. read ${runDir}/02-notes.md（第一行 fingerprint=manifestSha）；pwsh 核对 02 第一行 == sha(00-manifest.json)；抽验每个 sN.md 按 body-v2 口径（来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与））与 manifest 一致。任一不符 → 返回 {"status":"stale"}。
3. 算 notesFingerprint = sha(02-notes.md)。read ${runDir}/03-report.md（若存在）：第一行 "notesFingerprint: <当前值>" 且正文结构合格，且本消息无【修复指令】 → 返回 {"status":"skipped","citations":<正文引用条数>}，不要重写。
${repairBlock}
   本消息含【修复指令】→ 忽略跳过规则，按修复指令重写全文。
3. 否则写 ${runDir}/03-report.md：第一行 "notesFingerprint: <当前值>"；结构化中文报告（概述/核心发现/细节/结论）。每个结论标注三层之一：[事实]（来源原文直接支持，附引用 [来源N](url)）/ [推断]（写明由哪些事实经什么推理链）/ [未核实]（无法从来源确认，说明原因）。只引用 manifest 里真实存在的 URL。写完算 sha(03-report.md) 备用。
4. 返回 {"status":"done","citations":<引用条数>}。
${JSON_ONLY}`,
    { label: `report-${attempt}`, schema: { type: 'object', properties: { status: { type: 'string' }, citations: { type: 'number' } }, required: ['status'] } }
  )
  if (!report) return abort('report', '阶段返回null或schema违约（原参数重跑即从磁盘断点续）')
  if (!['done', 'skipped'].includes(report.status)) return abort('report', 'status非法: ' + report.status)
  log('report: ' + report.status + (report.citations != null ? '，引用 ' + report.citations + ' 条' : ''))

  phase('qc')
  qc = chaos === 'qc-null' ? null : await agent(
    `你是流水线阶段4（引用与产物检查，独立复核者，不要信任前序阶段的自述）。运行目录：${runDir}（相对会话 cwd）。
指纹规则（算法版本 body-v2）：02/03/04 头行指纹=整文件指纹 pwsh (Get-FileHash 'F' -Algorithm SHA256).Hash.ToLower().Substring(0,16)；来源文件比对用 body-v2 口径（来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与））。指纹只用于写进文件与内部比对，**绝不出现在你的最终回复里**。
先算 reportFp = sha(03-report.md)。然后五查：
一、清单完整性：read 00-manifest.json；核对 "fingerprintAlgo" 存在且等于 "body-v2"（缺失或旧口径 → FAIL 项：指纹算法版本不符）；核对 manifest.topic 与本任务主题一致（不一致 → FAIL 项：主题参数变化未重建）；glob 01-sources/*.md；条目数=文件数、id 连续（s1..sN）、每文件 read 非空、pwsh 按 body-v2 口径（来源正文段（body-v2：从 '## 关键事实' 标题行起、含该行，到文件尾，UTF8 SHA256 前16位小写；fetchedAt 等头部元数据不参与））重算每个文件指纹与 manifest 条目一致（每个都查，不许只查第一个）。
二、指纹链：sha(00-manifest.json) == 02 第一行；sha(02-notes.md) == 03 第一行；reportFp == 04 第一行（若 04 已存在则注明是旧文件）。
三、引用一致性：读 03-report.md 全部 [来源N](url)，与 manifest 对照（编号与 URL 都要一致），计数。
四、内容支持检查：对报告每个 [事实] 结论，在来源文件原文中找到直接支持片段；找不到 → FAIL 项。[推断] 检查推理链是否写明；[未核实] 检查是否确实无法核实。
五、重抓抽样：web_fetch 抽 1-2 个 URL，核对返回内容与对应 sN.md 关键事实不矛盾（不可达 → 如实记录，不判 FAIL）。
全部完成后写 ${runDir}/04-qc.md：第一行 "reportFingerprint: sha:<reportFp>"（注意必须带 sha: 前缀，格式精确），然后五查全表 + 总体判定 PASS 或 FAIL。
返回 {"verdict":"PASS"或"FAIL","issues":[<每个FAIL项，含编号与证据>],"citationsChecked":<n>,"filesChecked":<n>}。
${JSON_ONLY}`,
    { label: `qc-${attempt}`, schema: { type: 'object', properties: { verdict: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } }, citationsChecked: { type: 'number' }, filesChecked: { type: 'number' } }, required: ['verdict', 'issues'] } }
  )
  if (!qc) return abort('qc', '阶段返回null或schema违约（原参数重跑即从磁盘断点续）')
// v2.5.1 严格判定：verdict 必须精确等于 'PASS'/'FAIL'，其余一律按 FAIL（不再 includes 宽容匹配）
const verdict = (qc.verdict === 'PASS' || qc.verdict === 'FAIL') ? qc.verdict : 'FAIL'
  log('QC 第' + attempt + '轮: ' + verdict + (qc.issues && qc.issues.length ? '，问题 ' + qc.issues.length + ' 项' : '，无问题'))
  if (verdict === 'PASS') {
    return { result: 'PASS', topic, runDir, collectStatus: collect.status, digestStatus: digest.status, digestFindings: digest.findings, reportStatus: report.status, citations: report.citations, repairHistory, qc }
  }
  if (attempt === 2) return { result: 'FAIL_AFTER_REPAIR', topic, runDir, collectStatus: collect.status, digestStatus: digest.status, reportStatus: report.status, repairHistory, qc }
  repairHistory.push({ attempt, issues: qc.issues })
  repairNote = (qc.issues && qc.issues.length ? qc.issues : ['QC未通过但未给出具体问题']).join('\n')
}
