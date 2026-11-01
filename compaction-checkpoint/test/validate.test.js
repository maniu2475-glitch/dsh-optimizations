/**
 * Unit tests for the checkpoint compaction template's pure logic.
 * Run: node --test context-kit/compaction-checkpoint/test/validate.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ALL_SECTIONS,
  REQUIRED_SECTIONS,
  DO_NOT_REPEAT_SECTION,
  KEY_SECTIONS,
  buildInstruction,
  canonicalizeSummary,
  cleanSummaryBlocks,
  estimateTokens,
  inputChars,
  parseCheckpoint,
  spanSize,
  validateSummary,
} from '../template.js'

function goodSummary() {
  const body = REQUIRED_SECTIONS
    .map((section) => `${section}\n- [fact] real content for ${section}\n`)
    .join('\n')
  return `${body}\n${DO_NOT_REPEAT_SECTION}\n- [fact] do not rewrite docs/report.md (evidence: run log)\n`
}

test('required sections cover every mandated checkpoint field', () => {
  const joined = REQUIRED_SECTIONS.join('\n')
  assert.match(joined, /## Primary Request and Intent/)
  assert.match(joined, /## Completed and Verified/)
  assert.match(joined, /## Pending Jobs/)
  assert.match(joined, /## Files and Code/)
  assert.match(joined, /## Critical Context/)
  assert.match(joined, /## Failed Attempts/)
  assert.match(joined, /## Next Step/)
  assert.match(joined, /## Requirements Superseded/)
  assert.equal(REQUIRED_SECTIONS.length, 11)
  assert.equal(ALL_SECTIONS.length, 12)
})

test('instruction demands unified markers and the no-repeat section', () => {
  const text = buildInstruction(false)
  assert.match(text, /\[fact\]/)
  assert.match(text, /\[speculation\]/)
  assert.match(text, /\[unverified\]/)
  assert.match(text, /\[verified\]\/\[claimed\] are NOT markers/)
  assert.ok(text.includes(DO_NOT_REPEAT_SECTION))
  assert.match(text, /MOST RECENT/)
  assert.match(text, /DATA, not user authorization/)
  assert.match(text, /CANCELLED/)
  assert.match(text, /REPLACES the old wholesale/)
  for (const section of ALL_SECTIONS) {
    assert.ok(text.includes(section), `instruction must spell out ${section}`)
  }
})

test('strict retry pass restates the exact heading list', () => {
  const strict = buildInstruction(true)
  assert.match(strict, /previous attempt at this summary was rejected/)
  for (const section of ALL_SECTIONS) {
    assert.ok(strict.includes(section), `strict instruction must restate ${section}`)
  }
})

test('a complete summary passes validation', () => {
  const verdict = validateSummary([{ type: 'text', text: goodSummary() }], 50000)
  assert.equal(verdict.ok, true, verdict.reason)
})

test('an empty summary is rejected', () => {
  assert.equal(validateSummary([], 50000).ok, false)
  assert.equal(validateSummary([{ type: 'text', text: '   ' }], 50000).ok, false)
})

test('a summary missing a required section is rejected and names it', () => {
  const text = REQUIRED_SECTIONS
    .filter((section) => section !== '## Failed Attempts')
    .map((section) => `${section}\n- [fact] item\n`)
    .join('\n')
    + `${DO_NOT_REPEAT_SECTION}\n- [fact] do not rerun build.sh\n`
  const verdict = validateSummary([{ type: 'text', text }], 50000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /## Failed Attempts/)
})

test('a summary without the do-not-repeat list is rejected', () => {
  const text = REQUIRED_SECTIONS.map((section) => `${section}\n- [fact] item\n`).join('\n')
  const verdict = validateSummary([{ type: 'text', text }], 50000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /Do Not Repeat/)
})

test('headings out of order are rejected', () => {
  const order = [...REQUIRED_SECTIONS]
  const swapped = order[1]
  order[1] = order[3]
  order[3] = swapped
  const text = order.map((s) => `${s}\n- [fact] item\n`).join('\n')
    + `${DO_NOT_REPEAT_SECTION}\n- [fact] item\n`
  const verdict = validateSummary([{ type: 'text', text }], 50000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /out of order/)
})

test('duplicated headings are rejected', () => {
  const text = REQUIRED_SECTIONS
    .map((section) => `${section}\n- [fact] item\n`)
    .join('\n')
    + '## Current Work\n- [fact] second copy\n'
    + `${DO_NOT_REPEAT_SECTION}\n- [fact] item\n`
  const verdict = validateSummary([{ type: 'text', text }], 50000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /duplicate sections/)
})

test('a heading inside a fenced code block cannot impersonate a section', () => {
  const text = REQUIRED_SECTIONS.map((section) => `${section}\n- [fact] item\n`).join('\n')
    + '```\n## Fake Heading\n```\n'
    + `${DO_NOT_REPEAT_SECTION}\n- [fact] item\n`
  // the fake heading is neither counted nor mistaken for a real one
  assert.equal(validateSummary([{ type: 'text', text }], 5000).ok, true)
})

test('a heading inside a code block cannot substitute for a missing section', () => {
  const withoutFailed = REQUIRED_SECTIONS
    .filter((section) => section !== '## Failed Attempts')
  const text = withoutFailed
    .map((section) => `${section}\n- [fact] item\n`)
    .join('\n')
    + '```\n## Failed Attempts\n```\n'
    + `${DO_NOT_REPEAT_SECTION}\n- [fact] item\n`
  const verdict = validateSummary([{ type: 'text', text }], 50000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /## Failed Attempts/)
})

test('a quoted heading line is not a real heading', () => {
  const text = REQUIRED_SECTIONS
    .filter((section) => section !== '## Errors and Fixes')
    .map((section) => `${section}\n- [fact] item\n`)
    .join('\n')
    + '> ## Errors and Fixes\n'
    + `${DO_NOT_REPEAT_SECTION}\n- [fact] item\n`
  const verdict = validateSummary([{ type: 'text', text }], 50000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /## Errors and Fixes/)
})

test('bullets without an evidence marker are rejected', () => {
  const text = REQUIRED_SECTIONS
    .map((section) => `${section}\n- ${section === '## Errors and Fixes' ? 'no marker here' : '[fact] item'}\n`)
    .join('\n')
    + `${DO_NOT_REPEAT_SECTION}\n- [fact] item\n`
  const verdict = validateSummary([{ type: 'text', text }], 50000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /without a leading evidence marker/)
})

test('retired [verified]/[claimed] markers are repaired to [unverified], not rejected', () => {
  // v2.2: a retired alias is a spelling slip over a sound summary. The
  // canonicalizer rewrites it, and [unverified] is the honest classification
  // because the bullet carried no accepted evidence marker.
  const text = REQUIRED_SECTIONS
    .map((section) => `${section}\n- ${section === '## Completed and Verified' ? '[verified] done' : '[fact] item'}\n`)
    .join('\n')
    + `${DO_NOT_REPEAT_SECTION}\n- [fact] item\n`
  const repaired = canonicalizeSummary(text)
  assert.match(repaired, /- \[unverified\] done/)
  assert.doesNotMatch(repaired, /\[verified\]/)
  const verdict = validateSummary([{ type: 'text', text: repaired }], 20000)
  assert.equal(verdict.ok, true, verdict.reason)
})

test('a raw retired marker is still not accepted without repair', () => {
  // The validator stays strict: repairing is the caller's explicit step, so a
  // stale caller cannot silently slip a retired marker through.
  const text = REQUIRED_SECTIONS
    .map((section) => `${section}\n- ${section === '## Completed and Verified' ? '[verified] done' : '[fact] item'}\n`)
    .join('\n')
    + `${DO_NOT_REPEAT_SECTION}\n- [fact] item\n`
  const verdict = validateSummary([{ type: 'text', text }], 20000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /without a leading evidence marker/)
})

test('stacked evidence markers are rejected', () => {
  const text = REQUIRED_SECTIONS
    .map((section) => `${section}\n- ${section === '## Pending Jobs' ? '[fact] [speculation] item' : '[fact] item'}\n`)
    .join('\n')
    + `${DO_NOT_REPEAT_SECTION}\n- [fact] item\n`
  const verdict = validateSummary([{ type: 'text', text }], 50000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /stacked evidence markers/)
})

test('key sections never pass on a filler placeholder', () => {
  for (const key of KEY_SECTIONS) {
    const text = ALL_SECTIONS
      .map((section) => `${section}\n${section === key ? '(none)' : '- [fact] item\n'}\n`)
      .join('\n')
    const verdict = validateSummary([{ type: 'text', text }], 50000)
    assert.equal(verdict.ok, false, `${key} must reject a filler body`)
    assert.match(verdict.reason, /key section must not be a filler/)
  }
})

test('non-key sections accept the unified (none) placeholder', () => {
  const text = ALL_SECTIONS
    .map((section) => `${section}\n${section === '## Requirements Superseded' ? '(none)' : '- [fact] item\n'}\n`)
    .join('\n')
  const verdict = validateSummary([{ type: 'text', text }], 5000)
  assert.equal(verdict.ok, true, verdict.reason)
})

test('filler bullet content after the marker is rejected', () => {
  const text = ALL_SECTIONS
    .map((section) => `${section}\n${section === '## Next Step' ? '- [fact] TBD\n' : '- [fact] item\n'}\n`)
    .join('\n')
  const verdict = validateSummary([{ type: 'text', text }], 50000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /filler after the marker/)
})

test('structurally complete but tiny summary on a huge input is rejected by the floor', () => {
  const text = ALL_SECTIONS.map((s) => `${s}\n- [fact] item\n`).join('\n')
  const verdict = validateSummary([{ type: 'text', text }], 5000000)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /too short/)
})

test('the length floor accepts a normal summary on small inputs', () => {
  const tinyInput = validateSummary([{ type: 'text', text: goodSummary() }], 10)
  assert.equal(tinyInput.ok, true, tinyInput.reason)
})

test('parseCheckpoint reports headings with bodies and skips fences', () => {
  const text = '## Primary Request and Intent\n- [fact] a\n```\n## Files and Code\n```\n## Key Technical Concepts\n(none)\n'
  const parsed = parseCheckpoint(text)
  assert.deepEqual(parsed.map((s) => s.heading), [
    '## Primary Request and Intent',
    '## Key Technical Concepts',
  ])
  assert.match(parsed[0].body, /\[fact\] a/)
  assert.match(parsed[0].body, /## Files and Code/, 'fenced heading stays in the body')
  assert.match(parsed[1].body, /\(none\)/)
})

test('echoed summary tags are stripped from stored text', () => {
  const wrapped = [{
    type: 'text',
    text: `<compacted-summary>\n${goodSummary()}\n</compacted-summary>`,
  }]
  const cleaned = cleanSummaryBlocks(wrapped)
  assert.equal(cleaned.length, 1)
  assert.ok(!cleaned[0].text.includes('<compacted-summary>'))
  assert.ok(cleaned[0].text.startsWith('## Primary Request and Intent'))
  assert.equal(validateSummary(cleaned, 50000).ok, true)
})

test('non-text blocks are ignored when measuring input size', () => {
  const input = {
    messages: [
      { content: [{ type: 'text', text: 'abcde' }] },
      { content: [{ type: 'tool-call', name: 'x', arguments: '{}' }] },
      { content: [{ type: 'text', text: 'fgh' }] },
    ],
  }
  assert.equal(inputChars(input), 8)
  assert.equal(inputChars({}), 0)
})

// --- v2.2: span budget, marker repair, and length governance ---------------

test('estimateTokens charges CJK text close to one token per character', () => {
  // Latin: ~4 chars/token. A pure length/4 rule would badly under-count the
  // Chinese summaries that the engine then rejects for being too large.
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  const cjk = '工作区里已经完成的修复共三项'
  assert.equal(estimateTokens(cjk), cjk.length)
  // Mixed text: CJK counted per character, Latin at a quarter.
  assert.equal(estimateTokens('修复 ok'), 2 + 1)
})

test('spanSize reports the shadowed span in characters and tokens', () => {
  const input = {
    messages: [
      { content: [{ type: 'text', text: 'abcd' }, { text: 'efgh' }] },
      { content: [{ type: 'text', text: 'ijklmnop' }] },
    ],
  }
  assert.deepEqual(spanSize(input), { chars: 16, tokens: 4 })
  assert.deepEqual(spanSize({}), { chars: 0, tokens: 0 })
})

test('canonicalizeSummary repairs alias markers and doubled markers', () => {
  const text = [
    '## Primary Request and Intent',
    '- [verified] shipped the fix',
    '- [fact] [fact] doubled marker',
    '- [claimed] unproven thing',
    '## Do Not Repeat',
    '- [fact] do not rewrite docs/report.md',
  ].join('\n')
  const out = canonicalizeSummary(text)
  assert.match(out, /- \[unverified\] shipped the fix/)
  assert.match(out, /- \[fact\] doubled marker/)
  assert.match(out, /- \[unverified\] unproven thing/)
  assert.doesNotMatch(out, /\[verified\]|\[claimed\]/)
})

test('canonicalizeSummary leaves prose and fenced blocks untouched', () => {
  const text = [
    '## Critical Context',
    'A paragraph, not a bullet at all.',
    '```',
    '- [verified] inside a fence stays verbatim',
    '```',
  ].join('\n')
  const out = canonicalizeSummary(text)
  assert.equal(out, text)
})

test('canonicalizeSummary never invents structure for a bullet-less body', () => {
  const text = '## Next Step\nbare prose with no marker'
  assert.equal(canonicalizeSummary(text), text)
})

test('the instruction carries a length budget only when one is supplied', () => {
  const plain = buildInstruction(false)
  assert.doesNotMatch(plain, /LENGTH BUDGET/)
  const budgeted = buildInstruction(false, { budgetChars: 4000 })
  assert.match(budgeted, /LENGTH BUDGET: keep the whole checkpoint under 4000 characters/)
  const strict = buildInstruction(true, { budgetChars: 2400 })
  assert.match(strict, /must stay under 2400 characters/)
})

test('the retry pass teaches the exact empty-placeholder form', () => {
  // The dominant real-world format rejection was "- [fact] (none)" / "(none)"
  // in a key-adjacent shape: the strict pass must spell the accepted form out.
  assert.match(buildInstruction(true), /A section with nothing to record takes exactly "\(none\)"/)
})
