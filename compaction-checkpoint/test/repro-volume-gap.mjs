/**
 * Reproduction of the two compaction failure classes found in real session
 * logs (session-830009d0 and the 123-session scan, 2026-11-01).
 *
 * Class A -- "summary is not smaller than the shadowed content" (26/61 real
 * compaction failures). Reconstructed with the exact figures the engine
 * reported: a 22-token span replaced by a 683-token 12-section checkpoint.
 * Root cause: the instruction asked for eleven mandated sections and never
 * said the result had to be smaller than the span it replaces, so the model
 * wrote a checkpoint larger than the content it condensed. The engine throws
 * AFTER the plugin's summarize() resolved, so the plugin's cooldown never
 * learned about it and the same pair of requests repeated every turn.
 *
 * Class B -- a retired marker such as [verified] costing a whole retry
 * (10/61). Root cause: the validator rejected a spelling slip over an
 * otherwise sound checkpoint.
 *
 * Run: node context-kit/compaction-checkpoint/test/repro-volume-gap.mjs
 * Exits non-zero when the regression is present (pre-fix behaviour).
 */

import assert from 'node:assert/strict'

import { apply, ERROR_CODES } from '../index.js'
import { ALL_SECTIONS, buildInstruction, canonicalizeSummary, validateSummary } from '../template.js'

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name + ' :: ' + error.message])
  }
}

/**
 * A structurally VALID checkpoint padded to `size` characters.
 *
 * Valid on purpose: the point of class A is that a perfectly well-formed
 * checkpoint can still be rejected for being larger than the span, so the
 * structure must not be the thing that trips first.
 */
function checkpointOf(size) {
  const line = '- [fact] ' + 'x'.repeat(200) + '\n'
  let text = ALL_SECTIONS.map((s) => `${s}\n${line}`).join('\n')
  while (text.length < size) text += line
  return text
}

// --- Class A: the instruction now carries a length budget ---------------
check('A1 the instruction states a length budget derived from the span', () => {
  const budgeted = buildInstruction(false, { budgetChars: 5000 })
  assert.match(budgeted, /LENGTH BUDGET/)
  assert.match(budgeted, /under 5000 characters/)
  assert.match(budgeted, /rejected and wastes the whole compaction/)
})

check('A2 the strict retry pass repeats the budget', () => {
  const strict = buildInstruction(true, { budgetChars: 3000 })
  assert.match(strict, /must stay under 3000 characters/)
})

// --- Class A: an oversize checkpoint is now rejected by the plugin ------
function installHarness(config) {
  const logs = []
  const logger = {
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
  }
  const compaction = { config: { maxTokens: 8192 }, async summarize() { throw new Error('stock') } }
  const llm = {}
  apply({ logger, inject(_n, fn) { fn({ logger, effect() {}, compaction, llm }) }, effect() {} }, config)
  return { compaction, llm, logs }
}

function tinySpan() {
  // 22 route tokens, the exact size the engine reported when it rejected a
  // 683-token checkpoint.
  return { messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(88) }] }], tools: undefined }
}

function agent() {
  return agentFor('repro-session')
}

function agentFor(sessionId) {
  return {
    options: { provider: 'p', model: 'm' },
    session: { id: sessionId, requestHeader: () => ({ config: undefined }), toolHistory: () => [] },
  }
}

async function main() {
  const { compaction, llm, logs } = installHarness({ failureCooldownMs: 60000, maxSummaryAttempts: 2 })
  let calls = 0
  llm.stream = async function* stream() {
    calls += 1
    yield { type: 'text-delta', text: checkpointOf(680 * 4) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  let first
  try {
    await compaction.summarize(tinySpan(), agent(), undefined)
    first = 'accepted (regression)'
  } catch (error) {
    first = error.code
  }
  results.push([first === ERROR_CODES.FORMAT ? 'PASS' : 'FAIL',
    `A3 an oversize checkpoint is refused by the plugin (got ${first})`])
  results.push([calls === 2 ? 'PASS' : 'FAIL',
    `A4 both attempt budgets were spent inside maxSummaryAttempts (calls=${calls})`])
  results.push([logs.some(([, m]) => m.includes('would not shrink the span')) ? 'PASS' : 'FAIL',
    'A5 the rejection names the size reason the model can act on'])

  // Class A, second half: the engine's post-hook rejection still reaches the
  // cooldown, so the next turn costs nothing. Uses its own session, because
  // the A3 checks above already put `repro-session` into cooldown.
  const engineError = new Error(
    'summary is not smaller than the shadowed content (683 estimated framed tokens >= 22)',
  )
  const turn = compaction.summarize(tinySpan(), agentFor('repro-engine-gate'), undefined)
  await turn.catch(() => {})
  const observed = turn.checkpointObserve(engineError)
  let second
  try {
    compaction.summarize(tinySpan(), agentFor('repro-engine-gate'), undefined)
    second = 'issued another request (regression)'
  } catch (error) {
    second = error.code
  }
  results.push([observed === true ? 'PASS' : 'FAIL', 'A6 the engine size rejection is recognised'])
  results.push([second === ERROR_CODES.COOLDOWN ? 'PASS' : 'FAIL',
    `A7 the next turn is cooled down instead of repeating the pair (got ${second})`])

  // --- Class B: marker repair -------------------------------------------
  check('B1 a retired [verified] marker is rewritten instead of rejected', () => {
    const text = ALL_SECTIONS
      .map((s) => `${s}\n- ${s === '## Completed and Verified' ? '[verified] done' : '[fact] item'}\n`)
      .join('\n')
    const repaired = canonicalizeSummary(text)
    assert.match(repaired, /- \[unverified\] done/)
    const verdict = validateSummary([{ type: 'text', text: repaired }], 20000)
    assert.equal(verdict.ok, true, verdict.reason)
  })

  check('B2 a raw retired marker is still rejected by the validator alone', () => {
    const text = ALL_SECTIONS
      .map((s) => `${s}\n- ${s === '## Completed and Verified' ? '[verified] done' : '[fact] item'}\n`)
      .join('\n')
    const verdict = validateSummary([{ type: 'text', text }], 20000)
    assert.equal(verdict.ok, false)
  })

  let failed = 0
  for (const [status, name] of results) {
    if (status === 'FAIL') failed += 1
    console.log(`${status}  ${name}`)
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
