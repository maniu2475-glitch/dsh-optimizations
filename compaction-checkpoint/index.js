/**
 * Checkpoint-quality compaction for DeepSeek Harness.
 *
 * This plugin does not fork the stock backend: it keeps `compaction-basic`
 * loaded so that `ctx.compaction`, the threshold policy, retention budget,
 * tool-pairing balance, transaction framing and logging all stay exactly as the
 * shipped implementation has them. It replaces only the summarization step,
 * which the stock README documents as the customization point.
 *
 * Why it re-implements the LLM call rather than wrapping it: the stock
 * instruction is a module-internal constant, so a wrapper can inspect the
 * summary but cannot change what the model was asked for. To get the stricter
 * checkpoint template, this plugin issues the summarizing request itself,
 * replaying the conversation prefix and appending its own instruction -- the
 * same warm-prefix-cache strategy the stock call uses.
 *
 * Why it imports nothing from the Harness: in this installation the Harness
 * packages live inside `app.asar`. A plugin resolved from a profile cannot
 * import them, and installing a second copy of `dsh-llm` into the profile
 * registers duplicate providers and breaks boot. So the streaming chunks are
 * assembled here with a small local assembler, and every service is reached
 * through `ctx`.
 *
 * Reliability model (v2):
 *  - Stream termination is mandatory. The assembler starts with NO finish
 *    state; a stream that ends without a terminal `finish` chunk (drop,
 *    interruption) fails the attempt instead of defaulting to a clean stop.
 *    Finish kinds map fail-closed exactly like the stock backend:
 *    error/aborted -> immediate failure, max-tokens -> incomplete checkpoint,
 *    tool-calls -> unexpected tool call during summarization (format failure).
 *  - Cancellation is honoured everywhere: before each attempt, via the signal
 *    forwarded to the adapter, and in the window between a validated summary
 *    and the commit (the caller's surface is never replaced after a cancel).
 *  - Retries are classified. Only FORMAT failures (structure rejected by the
 *    validator) may consume a further attempt. Provider/transport/auth errors
 *    are raised immediately -- the provider layer already has its own retry
 *    policy, so this plugin deliberately adds zero transport retries.
 *  - Anti-thrash cooldown: after a failed summarization the plugin refuses
 *    further attempts for the same session for a configurable window, so a
 *    persistently failing call does not fire once per turn.
 *  - Structural validation proves FORMAT only. It cannot prove content truth.
 *
 * @module @local/dsh-compaction-checkpoint
 */

import {
  DO_NOT_REPEAT_SECTION,
  REQUIRED_SECTIONS,
  buildInstruction,
  cleanSummaryBlocks,
  inputChars,
  validateSummary,
} from './template.js'

export {
  BASE_SECTIONS,
  EXTRA_SECTIONS,
  REQUIRED_SECTIONS,
  DO_NOT_REPEAT_SECTION,
  buildInstruction,
  cleanSummaryBlocks,
  inputChars,
  validateSummary,
} from './template.js'

/** Cordis plugin name. */
export const name = 'compaction-checkpoint'

/** Error codes used to classify summarization failures. */
export const ERROR_CODES = {
  ABORTED: 'CHECKPOINT_ABORTED',
  STREAM_INCOMPLETE: 'CHECKPOINT_STREAM_INCOMPLETE',
  MAX_TOKENS: 'MAX_TOKENS',
  UNEXPECTED_TOOL_CALL: 'CHECKPOINT_UNEXPECTED_TOOL_CALL',
  INTERFACE: 'CHECKPOINT_INTERFACE_ERROR',
  FORMAT: 'CHECKPOINT_FORMAT_REJECTED',
  COOLDOWN: 'CHECKPOINT_COOLDOWN',
}

/**
 * Failure classes. `format` may consume another attempt (bounded by
 * maxSummaryAttempts); every other class is raised immediately because a
 * retry from this layer cannot change the outcome.
 * @param {Error} error - thrown failure.
 * @returns {'format'|'cancel'|'interface'} classification.
 */
function classifyFailure(error) {
  const code = error?.code
  if (code === ERROR_CODES.ABORTED) return 'cancel'
  if (code === ERROR_CODES.STREAM_INCOMPLETE
    || code === ERROR_CODES.MAX_TOKENS
    || code === ERROR_CODES.INTERFACE) return 'interface'
  if (code === ERROR_CODES.UNEXPECTED_TOOL_CALL) return 'format'
  // Raw provider/transport exceptions (ECONNRESET, timeouts, auth throws...)
  // escape the stream loop itself: no checkpoint code means this layer can
  // never fix them by re-asking, so they are interface failures.
  return 'interface'
}

/** True when the error represents a user- or system-initiated cancellation. */
function isCancellation(error, signal) {
  if (signal?.aborted) return true
  if (error?.code === ERROR_CODES.ABORTED) return true
  return error?.name === 'AbortError'
}

/** True when a thrown value is an abort-shaped error (AbortError/DOMException). */
function isAbortLike(error) {
  return error !== null && error !== undefined
    && (error.name === 'AbortError'
      || (typeof DOMException !== 'undefined' && error instanceof DOMException))
}

/**
 * Copy an error so its (possibly read-only) fields can carry our codes.
 * DOMException's `code`/`name` have getters only; mutating them throws.
 * @param {Error} source - original error or abort reason.
 * @returns {Error} a safe re-throwable copy preserving message/stack.
 */
function rethrowable(source) {
  const copy = new Error(source.message, { cause: source })
  copy.stack = source.stack
  if (source.name !== undefined && source.name !== 'Error') {
    try {
      copy.name = source.name
    } catch {
      /* name is not writable on some exotics; message/cause carry it */
    }
  }
  if (typeof source.code !== 'undefined') {
    try {
      copy.code = source.code
    } catch {
      /* getter-only fields keep the original values via `cause` */
    }
  }
  return copy
}

/** Per-session cooldown bookkeeping: sessionId -> last failure timestamp. */
// (instance lives inside apply(); a fresh install resets it)

/**
 * Minimal replacement for the runtime block assembler.
 *
 * Mirrors the runtime protocol: `llm.stream()` yields text deltas, reasoning
 * deltas, tool-call deltas, usage snapshots and a terminal `finish` record
 * `{ kind, failure? }` (FinishReasonMap: stop | tool-calls | max-tokens |
 * aborted | error). The assembler starts with `finish === undefined`: a
 * stream that ends without the terminal record is an interruption, not a
 * clean stop. Unexpected tool-call deltas are recorded and fail the attempt.
 */
class TextAssembler {
  constructor() {
    this.text = ''
    this.finish = undefined
    this.usage = undefined
    this.sawToolCall = false
    this.sawReasoning = false
  }

  /**
   * Fold one stream chunk into the accumulator.
   * @param {object} chunk - one value from `llm.stream()`.
   */
  push(chunk) {
    if (chunk === null || chunk === undefined) return
    switch (chunk.type) {
      case 'text-delta':
        if (typeof chunk.text === 'string') this.text += chunk.text
        break
      case 'reasoning-delta':
        this.sawReasoning = true
        break
      case 'tool-call-delta':
        this.sawToolCall = true
        break
      case 'usage':
        this.usage = chunk.usage ?? this.usage
        if (chunk.replayState?.usage !== undefined) this.usage = chunk.replayState.usage
        break
      case 'finish': {
        // The terminal record. A missing/invalid `reason` is itself a
        // protocol violation: the runtime FinishReasonMap always carries a
        // kind, so synthesizing a clean stop here would mask a truncated
        // stream. Record an invalid terminal state AND fail the attempt now.
        const reason = chunk.reason
        if (reason === undefined || reason === null || typeof reason.kind !== 'string') {
          const error = new Error('finish chunk arrived without a valid reason '
            + '(protocol violation; refusing to default to stop)')
          error.code = ERROR_CODES.STREAM_INCOMPLETE
          this.finish = { kind: 'invalid', failure: { message: error.message } }
          throw error
        }
        this.finish = reason
        break
      }
      default:
        break
    }
  }

  /**
   * Assert the stream ended in a state that may produce a checkpoint.
   * Throws fail-closed otherwise; never fabricates a clean stop.
   *
   * Priority: the TERMINAL finish state decides the failure class. An early
   * tool-call fragment followed by a real error/aborted terminal state is an
   * interface/cancel failure (never retried here), NOT a format failure --
   * re-asking the model cannot fix an upstream rejection.
   */
  assertComplete() {
    if (this.finish === undefined) {
      const error = new Error('summarization stream ended without a terminal finish record '
        + '(interrupted, dropped, or consumed by an unexpected tool-call loop)')
      error.code = ERROR_CODES.STREAM_INCOMPLETE
      throw error
    }
    const kind = this.finish.kind
    // Terminal error/aborted/max-tokens first: they outrank earlier
    // tool-call fragments for classification purposes.
    if (kind === 'error' || kind === 'aborted') {
      const failure = this.finish.failure ?? {}
      const error = new Error(failure.message ?? 'summarization stream failed')
      // Keep the provider's own code visible, but classify by ORIGIN: an
      // error/aborted terminal state is an interface failure or a cancel
      // no matter what code the provider attached.
      error.providerCode = failure.code
      error.code = kind === 'aborted' ? ERROR_CODES.ABORTED : ERROR_CODES.INTERFACE
      throw error
    }
    if (kind === 'max-tokens') {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
      error.code = ERROR_CODES.MAX_TOKENS
      throw error
    }
    if (kind === 'invalid') {
      const error = new Error(this.finish.failure?.message
        ?? 'summarization stream ended in an invalid terminal state')
      error.code = ERROR_CODES.STREAM_INCOMPLETE
      throw error
    }
    if (this.sawToolCall || kind === 'tool-calls') {
      // Reached only with a structurally clean stop/tool-calls terminal
      // state: the model tried to answer with a tool call, which a stricter
      // retry (reminder: "Do NOT call any tool") may plausibly fix.
      const error = new Error('summarization model attempted a tool call; '
        + 'checkpoints accept text output only')
      error.code = ERROR_CODES.UNEXPECTED_TOOL_CALL
      throw error
    }
    if (kind !== 'stop') {
      const error = new Error(`unexpected finish kind "${kind}" from the summarization stream`)
      error.code = ERROR_CODES.INTERFACE
      throw error
    }
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing the stock backend
 * expects, so downstream surfaces recognize the replacement message.
 *
 * @param {Array<{type: string, text: string}>} summary - validated summary blocks.
 * @returns {Array<{type: 'text', text: string}>} framed blocks.
 */
function frameSummary(summary) {
  const PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
  return [
    { type: 'text', text: `${PREAMBLE}\n\n<compacted-summary>` },
    ...summary,
    { type: 'text', text: '</compacted-summary>' },
  ]
}

/**
 * Resolve the provider/model target for the summarizing call, in the same
 * precedence the stock backend uses: explicit config, then the session's own
 * routed model, then the agent's declared options.
 *
 * @param {object} config - resolved stock config.
 * @param {object} agent - routed agent handle.
 * @returns {{provider: string, model: string}} chosen target.
 */
function resolveTarget(config, agent) {
  const latest = agent?.session?.requestHeader?.()?.config
  const configured = config.summarizationProvider !== undefined
    && config.summarizationProvider !== null
    && String(config.summarizationProvider).length > 0
    ? { provider: config.summarizationProvider, model: config.summarizationModel }
    : undefined
  const agentTarget = agent?.options?.provider && agent?.options?.model
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined || target === null) {
    throw new Error(
      'no provider/model available for summarization: set both summarization config fields, '
      + 'route one request, or set both AgentOptions fields',
    )
  }
  return target
}

/**
 * Issue the summarizing request with the checkpoint instruction.
 *
 * Attempt budget: attempt 1 is always made (cooldown permitting). Only FORMAT
 * rejections consume further attempts; interface/cancel failures are raised
 * on the spot with their class logged, so the real number of provider calls
 * stays observable in the log line.
 *
 * @param {object} ctx - plugin context (logger).
 * @param {object} config - resolved stock config.
 * @param {object} input - replayed conversation prefix.
 * @param {object} agent - routed agent handle.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {number} maxAttempts - total attempts allowed for format fixes.
 * @returns {Promise<object>} accepted summary payload.
 */
async function summarizeWithCheckpoint(ctx, config, input, agent, signal, maxAttempts) {
  const sourceChars = inputChars(input)
  const target = resolveTarget(config, agent)
  const sessionId = agent?.session?.id ?? '(unknown-session)'
  let lastReason = 'no attempt made'
  let attemptsMade = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      const reason = signal.reason
      const error = reason instanceof Error ? rethrowable(reason) : new Error('compaction aborted before the attempt')
      if (error.code === undefined || isAbortLike(reason)) error.code = ERROR_CODES.ABORTED
      throw error
    }

    const strict = attempt > 1
    const assembler = new TextAssembler()
    const messages = [
      ...input.messages,
      {
        role: 'user',
        content: [{ type: 'text', text: buildInstruction(strict) }],
      },
    ]
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    }

    attemptsMade = attempt
    try {
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
      assembler.assertComplete()
    } catch (error) {
      const klass = classifyFailure(error)
      const cancelled = isCancellation(error, signal)
      ctx.logger.warn(
        `compaction checkpoint attempt ${attempt}/${maxAttempts} failed `
        + `[${cancelled ? 'cancel' : klass}] code=${error.code ?? 'n/a'} `
        + `attemptsMade=${attemptsMade}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      // Interface and cancel failures are not format problems: retrying here
      // would just stack a second retry layer on top of the provider's own
      // policy. Report immediately and fail closed.
      if (klass !== 'format' || attempt === maxAttempts) throw error
      lastReason = `${error.code}: ${error.message}`
      continue
    }

    const blocks = cleanSummaryBlocks([{ type: 'text', text: assembler.text }])
    const verdict = validateSummary(blocks, sourceChars)
    if (verdict.ok) {
      // Cancel window between a validated summary and the commit: a cancel
      // that lands here must not swap the durable surface mid-teardown.
      if (signal?.aborted) {
        const reason = signal.reason
        const error = reason instanceof Error
          ? rethrowable(reason)
          : new Error('compaction cancelled after validation, before commit')
        if (error.code === undefined || isAbortLike(reason)) error.code = ERROR_CODES.ABORTED
        ctx.logger.warn(`compaction checkpoint: ${error.message}; keeping the previous surface`)
        throw error
      }
      if (attempt > 1) {
        ctx.logger.info(`compaction checkpoint accepted on attempt ${attempt}/${maxAttempts}`)
      }
      ctx.logger.info(
        `compaction checkpoint candidate accepted: attemptsMade=${attempt} `
        + `chars=${verdict.chars} provider=${options.provider} model=${options.model} `
        + '(the engine commits it; the commit itself is visible as the '
        + 'engine\'s replacement user-message event)',
      )
      return {
        summary: frameSummary(blocks),
        rawOutput: blocks,
        llmStreamCall: true,
        provider: options.provider,
        model: options.model,
        maxTokens: config.maxTokens,
        ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
      }
    }

    lastReason = verdict.reason
    ctx.logger.warn(
      `compaction checkpoint attempt ${attempt}/${maxAttempts} rejected [format]: ${verdict.reason}`,
    )
  }

  const failure = new Error(
    `compaction checkpoint rejected after ${attemptsMade} attempt(s) [format] `
    + `(${lastReason}); the previous durable surface is kept and the turn `
    + 'continues over budget',
  )
  failure.code = ERROR_CODES.FORMAT
  throw failure
}

/**
 * Install the checkpoint summarizer over the stock backend's `summarize`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{enabled?: boolean, maxSummaryAttempts?: number, failureCooldownMs?: number}} [config] - options.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) {
    ctx.logger.info('compaction checkpoint disabled by config')
    return
  }
  const maxAttempts = Number.isInteger(config.maxSummaryAttempts) && config.maxSummaryAttempts > 0
    ? config.maxSummaryAttempts
    : 2
  const cooldownMs = Number.isFinite(config.failureCooldownMs) && config.failureCooldownMs >= 0
    ? config.failureCooldownMs
    : 60_000
  /** Per-session cooldown bookkeeping: sessionId -> last failure timestamp. */
  const lastFailureAt = new Map()

  ctx.inject(['compaction', 'llm'], (sub) => {
    const service = sub.compaction
    if (service === null || service === undefined) return
    if (typeof service.summarize !== 'function') {
      sub.logger.warn('compaction checkpoint skipped: service exposes no summarize() hook')
      return
    }
    if (service.__checkpointUpgrade === true) {
      sub.logger.info('compaction checkpoint already installed')
      return
    }

    const original = service.summarize
    const replacement = function summarize(input, agent, signal) {
      const backendConfig = (this ?? service).config ?? {}
      const sessionId = agent?.session?.id ?? '(unknown-session)'
      if (cooldownMs > 0) {
        const last = lastFailureAt.get(sessionId)
        if (last !== undefined && Date.now() - last < cooldownMs) {
          const error = new Error(
            `compaction checkpoint cooling down for ${cooldownMs}ms after a failed attempt `
            + `(session ${sessionId}); skipping to avoid per-turn repeat requests`,
          )
          error.code = ERROR_CODES.COOLDOWN
          sub.logger.warn(error.message)
          throw error
        }
      }
      return summarizeWithCheckpoint(sub, backendConfig, input, agent, signal, maxAttempts)
        .then(
          (payload) => {
            lastFailureAt.delete(sessionId)
            return payload
          },
          (error) => {
            if (error?.code !== ERROR_CODES.COOLDOWN && !isCancellation(error, signal)) {
              lastFailureAt.set(sessionId, Date.now())
            }
            throw error
          },
        )
    }

    try {
      service.summarize = replacement
      Object.defineProperty(service, '__checkpointUpgrade', {
        value: true,
        enumerable: false,
        configurable: true,
      })
    } catch (error) {
      sub.logger.warn(
        'compaction checkpoint could not install: '
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    sub.logger.info(
      `compaction checkpoint active: ${REQUIRED_SECTIONS.length} required sections + `
      + `"${DO_NOT_REPEAT_SECTION}", structural validation on, `
      + `${maxAttempts} attempt(s), failure cooldown ${cooldownMs}ms`,
    )

    sub.effect(() => () => {
      service.summarize = original
      try {
        delete service.__checkpointUpgrade
      } catch {
        /* the flag is only a double-install guard */
      }
      sub.logger.info('compaction checkpoint restored the stock summarize()')
    })
  })
}
