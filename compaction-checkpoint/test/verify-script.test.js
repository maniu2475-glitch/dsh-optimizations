import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SCRIPT = path.join(__dirname, '..', '..', 'verify-summary-source.js')

const CID_OK = '11111111-2222-3333-4444-555555555555'
const CID_NO_START = 'aaaaaaaa-2222-3333-4444-555555555555'
const CID_ERR = 'bbbbbbbb-2222-3333-4444-555555555555'
const CID_NO_REPLACE = 'cccccccc-2222-3333-4444-555555555555'
const CID_ORDER = 'dddddddd-2222-3333-4444-555555555555'

function ev(seq, type, data, time) {
  return JSON.stringify({ seq, type, time: time ?? '2026-10-31T00:00:00Z', data })
}

function summaryData(id, turn) {
  return {
    compactionId: id, turn,
    summary: [
      { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span.' },
      { type: 'text', text: '<compacted-summary>\n## Primary Request and Intent\n- [fact] x\n## Do Not Repeat\n- [fact] y\n</compacted-summary>' },
    ],
    model: 'm', provider: 'p', shadowedSeqs: [1, 2],
  }
}

function writeLog(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-log-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const lines = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
  const raw = Buffer.from(lines.join('\n') + '\n', 'utf8')
  // 与真实会话日志同构：单帧 zstd
  fs.writeFileSync(file, zlib.zstdCompressSync(raw))
  return file
}

function runScript(file, extra = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, file, '--json', ...extra], { encoding: 'utf8' })
    return { stdout: JSON.parse(stdout), code: 0, raw: stdout }
  } catch (error) {
    // 退出码 1 = INCONCLUSIVE，stdout 仍是合法 JSON
    if (error.status === 1) {
      return { stdout: JSON.parse(error.stdout), code: 1, raw: error.stdout }
    }
    throw error
  }
}

test('ok: complete cluster (start→summary→replace→end) is COMMITTED with PLUGIN source', () => {
  const file = writeLog([
    ev(10, 'compaction/start', { compactionId: CID_OK, turn: 3 }),
    ev(11, 'compaction/summary', summaryData(CID_OK, 3)),
    { seq: 12, type: 'user/message', time: '2026-10-31T00:00:00Z', data: { source: { kind: 'compact-checkpoint', compactionId: CID_OK } } },
    ev(13, 'compaction/end', { compactionId: CID_OK, turn: 3 }),
  ])
  const { stdout, code } = runScript(file)
  assert.equal(code, 0)
  assert.equal(stdout.status, 'OK')
  assert.equal(stdout.last.state, 'COMMITTED')
  assert.equal(stdout.last.source, 'CHECKPOINT-PLUGIN')
  assert.equal(stdout.verdict, 'CHECKPOINT-PLUGIN')
})

test('counter-example: end carries an error → FAILED_AFTER_SUMMARY, never COMMITTED', () => {
  const file = writeLog([
    ev(10, 'compaction/start', { compactionId: CID_ERR, turn: 1 }),
    ev(11, 'compaction/summary', summaryData(CID_ERR, 1)),
    { seq: 12, type: 'user/message', time: 't', data: { source: { kind: 'compact-checkpoint', compactionId: CID_ERR } } },
    ev(13, 'compaction/end', { compactionId: CID_ERR, turn: 1, error: 'rejected after 2 attempt(s) [format]' }),
  ])
  const { stdout, code } = runScript(file)
  assert.equal(code, 0)
  assert.equal(stdout.last.state, 'FAILED_AFTER_SUMMARY')
  assert.equal(stdout.last.source, null, '未提交的簇不得输出来源归因')
  assert.equal(stdout.verdict, 'FAILED_AFTER_SUMMARY')
})

test('counter-example: missing start → START_MISSING, never COMMITTED', () => {
  const file = writeLog([
    ev(11, 'compaction/summary', summaryData(CID_NO_START, 2)),
    { seq: 12, type: 'user/message', time: 't', data: { source: { kind: 'compact-checkpoint', compactionId: CID_NO_START } } },
    ev(13, 'compaction/end', { compactionId: CID_NO_START, turn: 2 }),
  ])
  const { stdout } = runScript(file)
  assert.equal(stdout.last.state, 'START_MISSING')
  assert.equal(stdout.verdict, 'START_MISSING')
})

test('counter-example: missing replacement user/message → NOT_COMMITTED', () => {
  const file = writeLog([
    ev(10, 'compaction/start', { compactionId: CID_NO_REPLACE, turn: 4 }),
    ev(11, 'compaction/summary', summaryData(CID_NO_REPLACE, 4)),
    ev(13, 'compaction/end', { compactionId: CID_NO_REPLACE, turn: 4 }),
  ])
  const { stdout } = runScript(file)
  assert.equal(stdout.last.state, 'NOT_COMMITTED')
  assert.equal(stdout.verdict, 'NOT_COMMITTED')
})

test('counter-example: out-of-order events (end before summary) → ORDER_ANOMALY', () => {
  const file = writeLog([
    ev(10, 'compaction/start', { compactionId: CID_ORDER, turn: 5 }),
    ev(16, 'compaction/end', { compactionId: CID_ORDER, turn: 5 }),
    ev(12, 'compaction/summary', summaryData(CID_ORDER, 5)),
    { seq: 14, type: 'user/message', time: 't', data: { source: { kind: 'compact-checkpoint', compactionId: CID_ORDER } } },
  ])
  const { stdout } = runScript(file)
  assert.equal(stdout.last.state, 'ORDER_ANOMALY')
  assert.equal(stdout.verdict, 'ORDER_ANOMALY')
})

test('counter-example: duplicate same-type events → ORDER_ANOMALY', () => {
  const file = writeLog([
    ev(10, 'compaction/start', { compactionId: CID_OK, turn: 6 }),
    ev(11, 'compaction/summary', summaryData(CID_OK, 6)),
    { seq: 12, type: 'user/message', time: 't', data: { source: { kind: 'compact-checkpoint', compactionId: CID_OK } } },
    ev(13, 'compaction/end', { compactionId: CID_OK, turn: 6 }),
    ev(14, 'compaction/end', { compactionId: CID_OK, turn: 6 }),
  ])
  const { stdout } = runScript(file)
  assert.equal(stdout.last.state, 'ORDER_ANOMALY')
})

test('counter-example: bad JSON line → top-level INCONCLUSIVE with exit code 1', () => {
  const file = writeLog([
    ev(10, 'compaction/start', { compactionId: CID_OK, turn: 7 }),
    ev(11, 'compaction/summary', summaryData(CID_OK, 7)),
    { seq: 12, type: 'user/message', time: 't', data: { source: { kind: 'compact-checkpoint', compactionId: CID_OK } } },
    ev(13, 'compaction/end', { compactionId: CID_OK, turn: 7 }),
    '{"seq":14,"type":"compaction/end","data":{"compactionId":TRUNCATED',
  ])
  const { stdout, code } = runScript(file)
  assert.equal(code, 1)
  assert.equal(stdout.status, 'INCONCLUSIVE_LOG_DAMAGE')
  assert.equal(stdout.verdict, 'INCONCLUSIVE')
  assert.equal(stdout.badJsonLines, 1)
})

test('counter-example: corrupted zstd frame → top-level INCONCLUSIVE with exit code 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-log-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const good = zlib.zstdCompressSync(Buffer.from(ev(10, 'compaction/start', { compactionId: CID_OK, turn: 8 }) + '\n', 'utf8'))
  const broken = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03, 0x04])
  const tail = zlib.zstdCompressSync(Buffer.from(ev(13, 'compaction/end', { compactionId: CID_OK, turn: 8 }) + '\n', 'utf8'))
  fs.writeFileSync(file, Buffer.concat([good, broken, tail]))
  const { stdout, code } = runScript(file)
  assert.equal(code, 1)
  assert.equal(stdout.status, 'INCONCLUSIVE_LOG_DAMAGE')
  assert.equal(stdout.decodeFailures >= 1, true)
  assert.equal(stdout.verdict, 'INCONCLUSIVE')
})

test('plain text mode shares the same verdict as --json (committed session)', () => {
  const file = writeLog([
    ev(10, 'compaction/start', { compactionId: CID_OK, turn: 9 }),
    ev(11, 'compaction/summary', summaryData(CID_OK, 9)),
    { seq: 12, type: 'user/message', time: 't', data: { source: { kind: 'compact-checkpoint', compactionId: CID_OK } } },
    ev(13, 'compaction/end', { compactionId: CID_OK, turn: 9 }),
  ])
  const out = execFileSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' })
  assert.match(out, /VERDICT: CHECKPOINT-PLUGIN/)
  const bad = writeLog([
    ev(10, 'compaction/start', { compactionId: CID_ERR, turn: 10 }),
    ev(11, 'compaction/summary', summaryData(CID_ERR, 10)),
    ev(13, 'compaction/end', { compactionId: CID_ERR, turn: 10, error: 'x' }),
    '{"broken',
  ])
  let out2 = ''
  try {
    out2 = execFileSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8' })
  } catch (error) {
    out2 = String(error.stdout ?? '') + String(error.stderr ?? '')
    assert.equal(error.status, 1)
  }
  assert.match(out2, /VERDICT: INCONCLUSIVE/)
})
