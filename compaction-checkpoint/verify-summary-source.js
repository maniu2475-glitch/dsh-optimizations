#!/usr/bin/env node
/**
 * verify-summary-source.js — 判定一段会话日志里自动压缩的摘要来源与提交状态。
 *
 * 三层结论，绝不互相代替：
 *   1) SOURCE（来源特征）：位置式判据——摘要文本是否以插件 PREAMBLE 开头。
 *      官方模板的产物以正文开头；包含式检测会因会话自指内容假阳性（turn 45 教训）。
 *   2) EVIDENCE（提交证据）：按 compactionId 把 start/summary/end 与**替换事件**
 *      配成簇。提交的实证 = 同 compactionId 的 user/message 且
 *      source.kind === 'compact-checkpoint'（本机 rc.5 日志协议实测：
 *      summary 之后紧跟该 user/message，再 compaction/end）。
 *      COMMITTED 必须同时满足：
 *        a) start 存在；
 *        b) summary 存在；
 *        c) end 存在且 end.data 无 error 字段；
 *        d) 替换 user/message 存在（source.kind=compact-checkpoint）；
 *        e) 顺序成立：start.seq < summary.seq < replace.seq <= end.seq，
 *           且同 compactionId 无重复同型事件。
 *      任一不满足 → 按实际状态如实命名（FAILED_AFTER_SUMMARY /
 *      GENERATION_FAILED / START_MISSING / NO_SUMMARY / NOT_COMMITTED /
 *      ORDER_ANOMALY），绝不凭摘要模板特征推断"已提交"。
 *   3) HEALTH（日志完整性）：解压失败、坏 JSON 行使日志不可信。任一存在 →
 *      顶层判定统一 INCONCLUSIVE（机器可读 status + 退出码 1），明细照常展示
 *      ——不允许一边报解析错误一边输出成功。普通文本与 --json 共用同一套结论。
 *
 * 退出码：0 = 有明确判定（含全部簇 STOCK）；1 = INCONCLUSIVE；2 = 用法/IO 错误。
 *
 * 用法：
 *   node verify-summary-source.js <session.v4.jsonl.zstd> [--json] [--all]
 *     --all   列出日志内全部压缩簇（不只最近一次）
 *     --json  机器可读输出
 */
'use strict'

const fs = require('fs')
const zlib = require('zlib')

const PREAMBLE = 'This is an automatically generated checkpoint'
const ENHANCED_SECTIONS = [
  '## Completed and Verified',
  '## Failed Attempts',
  '## Requirements Superseded',
  '## Do Not Repeat',
]

function failWith(msg) {
  console.error('VERIFY-ERROR: ' + msg)
  process.exit(2)
}

function decodeLog(path) {
  const buf = fs.readFileSync(path)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const frames = []
  let p = 0
  while (true) {
    const i = buf.indexOf(MAGIC, p)
    if (i < 0) break
    frames.push(i)
    p = i + 4
  }
  if (frames.length === 0) failWith('no zstd frames found (not a session log?)')
  frames.push(buf.length)
  let text = ''
  let decodeFailures = 0
  for (let k = 0; k < frames.length - 1; k++) {
    try {
      text += zlib.zstdDecompressSync(buf.slice(frames[k], frames[k + 1])).toString('utf8')
    } catch {
      decodeFailures++
      // 该帧解压失败会吞掉其后帧的起始魔数，重扫一次，尽量少丢后续帧。
      if (k + 2 < frames.length) {
        const next = buf.indexOf(MAGIC, frames[k + 1] + 4)
        if (next > frames[k + 1] && next !== frames[k + 2]) frames[k + 2] = next
      }
    }
  }
  return { text, decodeFailures }
}

function parseEvents(text) {
  const events = []
  let badJsonLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      badJsonLines++
    }
  }
  return { events, badJsonLines }
}

/** 把 compaction 相关事件与替换 user/message 按 compactionId 配成簇。 */
function clusterCompactions(events) {
  const clusters = new Map()
  const adopt = (id) => {
    if (!clusters.has(id)) {
      clusters.set(id, { id, start: null, summary: null, end: null, replace: null, extra: [] })
    }
    return clusters.get(id)
  }
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    const type = typeof ev.type === 'string' ? ev.type : ''
    if (type.startsWith('compaction/')) {
      const id = ev.data && ev.data.compactionId
      if (typeof id !== 'string' || id.length === 0) continue
      const cluster = adopt(id)
      // 同一 compactionId 重复出现同型事件 = 协议异常，保留供判定
      if (type === 'compaction/start') {
        if (cluster.start === null) { cluster.start = ev; cluster.startLine = i }
        else cluster.extra.push(ev)
      } else if (type === 'compaction/summary') {
        if (cluster.summary === null) { cluster.summary = ev; cluster.summaryLine = i }
        else cluster.extra.push(ev)
      } else if (type === 'compaction/end') {
        if (cluster.end === null) { cluster.end = ev; cluster.endLine = i }
        else cluster.extra.push(ev)
      }
      continue
    }
    if (type === 'user/message') {
      const source = ev.data && ev.data.source
      if (source && source.kind === 'compact-checkpoint'
        && typeof source.compactionId === 'string') {
        const cluster = adopt(source.compactionId)
        if (cluster.replace === null) { cluster.replace = ev; cluster.replaceLine = i }
        else cluster.extra.push(ev)
      }
    }
  }
  return [...clusters.values()].sort((a, b) => {
    const seqOf = (c) => {
      for (const e of [c.start, c.summary, c.replace, c.end]) if (e) return e.seq
      return 0
    }
    return seqOf(a) - seqOf(b)
  })
}

/**
 * 簇状态判定。COMMITTED 是唯一"已提交"结论，五条件全过才算；
 * 其余状态如实命名，不做推断。
 */
function clusterState(cluster) {
  const { start, summary, end, replace } = cluster
  if (end && end.data && typeof end.data.error === 'string' && end.data.error.length > 0) {
    return summary ? 'FAILED_AFTER_SUMMARY' : 'GENERATION_FAILED'
  }
  if (!start) return 'START_MISSING'
  if (!summary) return 'NO_SUMMARY'
  if (!replace) return 'NOT_COMMITTED' // 有合格摘要但引擎没有产生替换事件
  if (!end) return 'NOT_COMMITTED'
  // 双序校验：seq 序与文件行序都必须成立（真实日志两者一致；
  // 只查其一会让合成/损坏日志漏判乱序）。
  const orderedSeq = start.seq < summary.seq
    && summary.seq < replace.seq
    && replace.seq <= end.seq
  const orderedLine = cluster.startLine < cluster.summaryLine
    && cluster.summaryLine < cluster.replaceLine
    && cluster.replaceLine <= cluster.endLine
  if (!orderedSeq || !orderedLine || cluster.extra.length > 0) return 'ORDER_ANOMALY'
  return 'COMMITTED'
}

function summarizeText(cluster) {
  if (!cluster.summary) return ''
  return (cluster.summary.data.summary || [])
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
}

function describe(cluster) {
  const state = clusterState(cluster)
  const text = summarizeText(cluster)
  const preambleAtStart = text.trimStart().startsWith(PREAMBLE)
  const enhanced = ENHANCED_SECTIONS.filter((h) => text.includes(h))
  const sourceFeature = preambleAtStart ? 'CHECKPOINT-PLUGIN' : 'STOCK-BACKEND'
  const committed = state === 'COMMITTED'
  return {
    compactionId: cluster.id,
    turn: cluster.start ? cluster.start.data.turn : null,
    startSeq: cluster.start ? cluster.start.seq : null,
    summarySeq: cluster.summary ? cluster.summary.seq : null,
    replaceSeq: cluster.replace ? cluster.replace.seq : null,
    endSeq: cluster.end ? cluster.end.seq : null,
    endError: cluster.end && cluster.end.data && cluster.end.data.error
      ? String(cluster.end.data.error).slice(0, 160)
      : null,
    state,
    // 来源特征只对"确实提交"的簇作最终归因；未提交的簇仅供参考字段照出
    source: committed ? sourceFeature : null,
    summarySourceFeature: sourceFeature,
    preambleAtStart,
    enhancedSections: enhanced.length + '/4',
    chars: text.length,
    model: cluster.summary ? cluster.summary.data.model : null,
    provider: cluster.summary ? cluster.summary.data.provider : null,
    shadowedSeqs: cluster.summary && Array.isArray(cluster.summary.data.shadowedSeqs)
      ? cluster.summary.data.shadowedSeqs.length
      : null,
    verdict: committed ? sourceFeature : state,
  }
}

function main() {
  const args = process.argv.slice(2)
  const path = args.find((a) => !a.startsWith('--'))
  if (!path) failWith('usage: node verify-summary-source.js <session.v4.jsonl.zstd> [--json] [--all]')
  const wantJson = args.includes('--json')
  const wantAll = args.includes('--all')

  let decoded
  try {
    decoded = decodeLog(path)
  } catch (error) {
    failWith('cannot read log: ' + error.message)
  }
  const { text, decodeFailures } = decoded
  const { events, badJsonLines } = parseEvents(text)
  const clusters = clusterCompactions(events)
  const described = clusters.map(describe)
  const last = described[described.length - 1] ?? null

  // HEALTH 门：解析层有任何缺损 → 顶层判定统一 INCONCLUSIVE（两种模式共用）
  const unhealthy = decodeFailures > 0 || badJsonLines > 0
  const topVerdict = unhealthy
    ? 'INCONCLUSIVE'
    : (last ? last.verdict : 'NO_COMPACTION')
  const status = unhealthy
    ? 'INCONCLUSIVE_LOG_DAMAGE'
    : (last ? 'OK' : 'OK_NO_COMPACTION')
  const exitCode = unhealthy ? 1 : 0

  if (wantJson) {
    console.log(JSON.stringify({
      log: path,
      status,
      verdict: topVerdict,
      decodeFailures,
      badJsonLines,
      clusters: described.length,
      last,
      all: wantAll ? described : undefined,
    }, null, 2))
    process.exit(exitCode)
  }

  console.log('log: ' + path)
  console.log('decodeFailures: ' + decodeFailures + (decodeFailures > 0 ? '  <-- 解压有失败' : ''))
  console.log('badJsonLines: ' + badJsonLines + (badJsonLines > 0 ? '  <-- 存在无法解析的行' : ''))
  console.log('compaction clusters: ' + described.length)
  if (wantAll) {
    for (const d of described) {
      console.log(
        `  [${d.state}] id=${d.compactionId.slice(0, 8)} turn=${d.turn} `
        + `seq=${d.startSeq}/${d.summarySeq}/${d.replaceSeq}/${d.endSeq} chars=${d.chars} `
        + `source=${d.source ?? '-'} feature=${d.summarySourceFeature} enhanced=${d.enhancedSections}`,
      )
    }
  }
  if (last) {
    console.log('last cluster:')
    for (const [k, v] of Object.entries(last)) {
      if (v !== null) console.log(`  ${k}: ${v}`)
    }
  }
  console.log('VERDICT: ' + topVerdict + (unhealthy ? '  <-- 日志缺损，判定不可信（明细仅供参考）' : ''))
  process.exit(exitCode)
}

main()
