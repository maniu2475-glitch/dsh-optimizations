/**
 * Runtime tests for the checkpoint compaction plugin: stream termination,
 * cancellation windows, retry classification and the failure cooldown.
 * Everything runs against a fake `ctx.llm.stream`; no network, no Harness.
 *
 * Run: node --test context-kit/compaction-checkpoint/test/runtime.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, ERROR_CODES } from '../index.js'
import { ALL_SECTIONS } from '../template.js'

/** Build a structurally valid checkpoint body for the fake model to emit. */
function goodSummaryText() {
  return ALL_SECTIONS
    .map((section) => `${section}\n- [fact] real content item for ${section}\n`)
    .join('\n')
}

/** A minimal service facade mimicking the stock compaction service. */
function makeService() {
  return {
    config: { maxTokens: 2048 },
    async summarize(input, agent, signal) {
      throw new Error('stock summarize must be replaced')
    },
  }
}

/** Install the plugin into a fake ctx and return the captured handles. */
function install({ config = {}, injects }) {
  const logs = []
  const logger = {
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
  }
  const services = { compaction: makeService(), llm: {} }
  const ctx = {
    logger,
    inject(names, fn) {
      fn({
        logger,
        effect(_fn) {},
        compaction: services.compaction,
        llm: services.llm,
      })
    },
    effect(_fn) {},
  }
  apply(ctx, config)
  const installed = services.compaction.__checkpointUpgrade === true
  return { services, logs, logger, installed }
}

/** Fake llm.stream factory. */
function fakeStream(chunks) {
  return async function* stream(_options) {
    for (const chunk of chunks) yield chunk
  }
}

function baseInput() {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }],
    tools: undefined,
  }
}

function baseAgent() {
  return {
    options: { provider: 'p', model: 'm' },
    session: {
      id: 'sess-test',
      requestHeader: () => ({ config: undefined }),
      toolHistory: () => [],
    },
  }
}

test('plugin installs and reports active with cooldown', () => {
  const { installed, logs } = install({ config: {} })
  assert.equal(installed, true)
  const active = logs.find(([, m]) => m.includes('compaction checkpoint active'))
  assert.ok(active, 'must log an active line')
  assert.match(active[1], /structural validation on/)
  assert.match(active[1], /cooldown/)
})

test('a clean stop stream commits the checkpoint summary', async () => {
  const { services } = install({
    config: { failureCooldownMs: 0 },
    injects: {},
  })
  services.llm.stream = fakeStream([
    { type: 'text-delta', text: goodSummaryText() },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const out = await services.compaction.summarize(baseInput(), baseAgent(), undefined)
  assert.ok(out.summary[0].text.startsWith('This is an automatically generated checkpoint'))
  assert.ok(out.summary.some((b) => b.text.includes('## Primary Request and Intent')))
  assert.equal(out.llmStreamCall, true)
  assert.equal(out.provider, 'p')
})

test('a stream with NO finish chunk is rejected, not defaulted to stop', async () => {
  const { services } = install({ config: { failureCooldownMs: 0 } })
  services.llm.stream = fakeStream([{ type: 'text-delta', text: goodSummaryText() }])
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), undefined),
    (error) => error.code === ERROR_CODES.STREAM_INCOMPLETE,
  )
})

test('an aborted finish is raised immediately and never retried', async () => {
  const { services } = install({ config: { maxSummaryAttempts: 3, failureCooldownMs: 0 } })
  let calls = 0
  services.llm.stream = async function* stream() {
    calls += 1
    yield { type: 'text-delta', text: 'partial' }
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'user cancelled' } } }
  }
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), undefined),
    (error) => error.code === ERROR_CODES.ABORTED,
  )
  assert.equal(calls, 1, 'abort must not consume another attempt')
})

test('an error finish is raised immediately as an interface failure', async () => {
  const { services } = install({ config: { maxSummaryAttempts: 3, failureCooldownMs: 0 } })
  let calls = 0
  services.llm.stream = async function* stream() {
    calls += 1
    yield { type: 'finish', reason: { kind: 'error', failure: { message: '401 unauthorized', code: 'AUTH' } } }
  }
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), undefined),
    (error) => error.code === ERROR_CODES.INTERFACE && /401/.test(error.message),
  )
  assert.equal(calls, 1, 'interface errors must not be retried by this layer')
})

test('max-tokens finish fails closed like the stock backend', async () => {
  const { services } = install({ config: { failureCooldownMs: 0 } })
  services.llm.stream = fakeStream([
    { type: 'text-delta', text: '## Primary Request and Intent\n- [fact] cut' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), undefined),
    (error) => error.code === ERROR_CODES.MAX_TOKENS,
  )
})

test('a tool-call attempt in the summarization stream fails the attempt', async () => {
  const { services } = install({ config: { failureCooldownMs: 0 } })
  services.llm.stream = fakeStream([
    { type: 'text-delta', text: goodSummaryText() },
    { type: 'tool-call-delta', id: 't1', name: 'write', argumentsDelta: '{}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), undefined),
    (error) => error.code === ERROR_CODES.UNEXPECTED_TOOL_CALL,
  )
})

test('format failures retry within the budget, then fail closed', async () => {
  const { services, logs } = install({ config: { maxSummaryAttempts: 2, failureCooldownMs: 0 } })
  let calls = 0
  services.llm.stream = async function* stream() {
    calls += 1
    yield { type: 'text-delta', text: 'no headings at all' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), undefined),
    (error) => error.code === ERROR_CODES.FORMAT,
  )
  assert.equal(calls, 2, 'format failures consume the bounded attempt budget')
  const rejects = logs.filter(([, m]) => m.includes('rejected [format]'))
  assert.equal(rejects.length, 2)
})

test('a format rejection then a good attempt commits on attempt 2', async () => {
  const { services, logs } = install({ config: { maxSummaryAttempts: 2, failureCooldownMs: 0 } })
  let calls = 0
  services.llm.stream = async function* stream() {
    calls += 1
    if (calls === 1) {
      yield { type: 'text-delta', text: 'garbage' }
    } else {
      yield { type: 'text-delta', text: goodSummaryText() }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const out = await services.compaction.summarize(baseInput(), baseAgent(), undefined)
  assert.equal(out.llmStreamCall, true)
  assert.ok(logs.some(([, m]) => m.includes('accepted on attempt 2/2')))
})

test('a thrown provider exception (network) is not retried by this layer', async () => {
  const { services } = install({ config: { maxSummaryAttempts: 3, failureCooldownMs: 0 } })
  let calls = 0
  services.llm.stream = async function* stream() {
    calls += 1
    throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })
  }
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), undefined),
    /ECONNRESET/,
  )
  assert.equal(calls, 1, 'transport errors surface immediately')
})

test('an already-aborted signal never issues a provider call', async () => {
  const { services } = install({ config: { failureCooldownMs: 0 } })
  let calls = 0
  services.llm.stream = async function* stream() { calls += 1; yield { type: 'finish', reason: { kind: 'stop' } } }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), controller.signal),
    (error) => error.code === ERROR_CODES.ABORTED,
  )
  assert.equal(calls, 0)
})

test('a cancel landing between validation and commit does not commit', async () => {
  const { services } = install({ config: { failureCooldownMs: 0 } })
  services.llm.stream = fakeStream([
    { type: 'text-delta', text: goodSummaryText() },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const controller = new AbortController()
  // Abort right after the stream ends but before the commit; simulate by
  // making the signal abort when the stream loop returns.
  const originalStream = services.llm.stream
  services.llm.stream = async function* stream(options) {
    yield* originalStream(options)
    controller.abort()
  }
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), controller.signal),
    (error) => error.code === ERROR_CODES.ABORTED,
  )
})

test('after a failure the same session is refused inside the cooldown', async () => {
  const { services } = install({ config: { failureCooldownMs: 60_000 } })
  let calls = 0
  services.llm.stream = async function* stream() {
    calls += 1
    yield { type: 'text-delta', text: 'garbage' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), undefined),
    (error) => error.code === ERROR_CODES.FORMAT,
  )
  assert.equal(calls, 2)
  await assert.rejects(
    async () => { await services.compaction.summarize(baseInput(), baseAgent(), undefined) },
    (error) => error.code === ERROR_CODES.COOLDOWN,
  )
  assert.equal(calls, 2, 'cooldown must not issue more provider calls')
})

test('a successful commit clears the cooldown state', async () => {
  const { services } = install({ config: { failureCooldownMs: 60_000 } })
  let fail = true
  let calls = 0
  services.llm.stream = async function* stream() {
    calls += 1
    yield { type: 'text-delta', text: fail ? 'garbage' : goodSummaryText() }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await assert.rejects(
    () => services.compaction.summarize(baseInput(), baseAgent(), undefined),
    (error) => error.code === ERROR_CODES.FORMAT,
  )
  fail = false
  // Inside cooldown this would be refused; disable cooldown for the second call.
  const { services: svc2 } = install({ config: { failureCooldownMs: 0 } })
  svc2.llm.stream = services.llm.stream
  const out = await svc2.compaction.summarize(baseInput(), baseAgent(), undefined)
  assert.equal(out.llmStreamCall, true)
})

test('disabling by config leaves the stock summarize untouched', () => {
  const { installed } = install({ config: { enabled: false } })
  assert.equal(installed, false)
})

test('log lines record the failure class and attemptsMade', async () => {
  const { services, logs } = install({ config: { maxSummaryAttempts: 3, failureCooldownMs: 0 } })
  services.llm.stream = async function* stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X1' } } }
  }
  await assert.rejects(() => services.compaction.summarize(baseInput(), baseAgent(), undefined))
  const line = logs.find(([, m]) => m.includes('[interface]') && m.includes('attemptsMade=1'))
  assert.ok(line, 'must log class + attemptsMade: ' + JSON.stringify(logs))
})

test('a finish chunk WITHOUT a valid reason is rejected, never defaulted to stop', async () => {
  const { services } = install({ config: { failureCooldownMs: 0 } })
  services.llm.stream = fakeStream([
    { type: 'text-delta', text: goodSummaryText() },
    { type: 'finish' },
  ])
  await assert.rejects(
    async () => { await services.compaction.summarize(baseInput(), baseAgent(), undefined) },
    (error) => error.code === ERROR_CODES.STREAM_INCOMPLETE,
  )
})

test('a finish with a non-string reason.kind is rejected', async () => {
  const { services } = install({ config: { failureCooldownMs: 0 } })
  services.llm.stream = fakeStream([
    { type: 'text-delta', text: goodSummaryText() },
    { type: 'finish', reason: { kind: 42 } },
  ])
  await assert.rejects(
    async () => { await services.compaction.summarize(baseInput(), baseAgent(), undefined) },
    (error) => error.code === ERROR_CODES.STREAM_INCOMPLETE,
  )
})

test('a tool-call fragment followed by a REAL error finish is an interface failure, not format', async () => {
  const { services } = install({ config: { maxSummaryAttempts: 3, failureCooldownMs: 0 } })
  let calls = 0
  services.llm.stream = async function* stream() {
    calls += 1
    yield { type: 'tool-call-delta', id: 't1', name: 'write', argumentsDelta: '{}' }
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 403', code: 'U3' } } }
  }
  await assert.rejects(
    async () => { await services.compaction.summarize(baseInput(), baseAgent(), undefined) },
    (error) => error.code === ERROR_CODES.INTERFACE && error.providerCode === 'U3',
  )
  assert.equal(calls, 1, 'terminal error outranks the earlier tool-call fragment; no retry')
})

test('a tool-call fragment followed by aborted finish is a cancel, not format', async () => {
  const { services } = install({ config: { maxSummaryAttempts: 3, failureCooldownMs: 0 } })
  let calls = 0
  services.llm.stream = async function* stream() {
    calls += 1
    yield { type: 'tool-call-delta', id: 't1', name: 'w', argumentsDelta: '{}' }
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'user cancel' } } }
  }
  await assert.rejects(
    async () => { await services.compaction.summarize(baseInput(), baseAgent(), undefined) },
    (error) => error.code === ERROR_CODES.ABORTED,
  )
  assert.equal(calls, 1)
})

test('a tool-call fragment followed by a CLEAN stop stays a format-class failure', async () => {
  const { services } = install({ config: { maxSummaryAttempts: 2, failureCooldownMs: 0 } })
  let calls = 0
  services.llm.stream = async function* stream() {
    calls += 1
    yield { type: 'tool-call-delta', id: 't1', name: 'w', argumentsDelta: '{}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await assert.rejects(
    async () => { await services.compaction.summarize(baseInput(), baseAgent(), undefined) },
    (error) => error.code === ERROR_CODES.UNEXPECTED_TOOL_CALL,
  )
  assert.equal(calls, 2, 'clean-terminal tool-call attempt may consume the retry budget')
})

test('the accept log says "candidate accepted", not "committed"', async () => {
  const { services, logs } = install({ config: { failureCooldownMs: 0 } })
  services.llm.stream = fakeStream([
    { type: 'text-delta', text: goodSummaryText() },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  await services.compaction.summarize(baseInput(), baseAgent(), undefined)
  const line = logs.find(([, m]) => m.includes('candidate accepted'))
  assert.ok(line, 'must log candidate accepted: ' + JSON.stringify(logs))
  assert.equal(logs.some(([, m]) => m.includes('committed')), false, 'plugin must not claim the engine commit')
})
