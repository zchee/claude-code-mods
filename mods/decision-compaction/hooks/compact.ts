import type {
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
} from 'claude-code'

import type { Limits } from './providers'
import { estimatedTokensOf, headOf } from './state'
import type { Call, Fitted, Stage } from './state'
import { bytesOf, noulOf } from './systemone'
import type { Questions, Reply, Wire } from './systemone'

/**
 * Sends one batch of questions about a state and resolves with the reply.
 */
export type Ask = (state: unknown, questions: Questions) => Promise<Reply>

/**
 * What one request may hold, in estimated tokens: the person's budgets,
 * held under what the provider documents, and the state's share of the
 * request held to what a batch of questions leaves.
 */
export type Budget = {
  stateTokens: number
  requestTokens: number
  questions?: number
  /**
   * For a provider that caps the request body in bytes: the bytes a body
   * may take, already held to `LIMIT_SHARE` of the cap, and the bytes it
   * takes besides its questions.
   */
  bytes?: { limit: number; state: number }
}

/**
 * The two probabilities answered for one call.
 */
export type Scores = {
  keepCall: number
  keepResult: number
}

/**
 * What happens to a call: `pinned` and `keep` leave it whole, `truncate`
 * keeps the call and the head of its result, `drop` removes both.
 */
export type Action = 'pinned' | 'keep' | 'truncate' | 'drop'

export type Decision = Scores & {
  call: Call
  action: Action
}

/**
 * What the batches reported between them.
 */
type Reported = {
  /**
   * The largest `input_tokens` any batch reported. Every batch sends the
   * same state, so the largest is the one to hold against the estimate.
   * A provider that counts the state once a question reports it multiplied
   * by the questions of that batch.
   */
  inputTokens?: number
  /**
   * The costs the batches reported, summed.
   */
  cost?: number
}

/**
 * A finished compaction: the conversation as it should read afterwards and
 * the figures the report is written from.
 */
export type Outcome = {
  messages: SessionMessage[]
  decisions: Decision[]
  charsBefore: number
  charsAfter: number
  stateTokens: number
  /**
   * The reduction the state needed; absent from an outcome that asked a
   * provider nothing.
   */
  stage?: Stage
  requests: number
  reported: Reported
  /**
   * How many results were in fact cut to their head. It can be fewer than
   * the `truncate` decisions: a result too short to gain from a cut is left
   * whole, and its call then counts with the ones kept.
   */
  shortened: number
}

/**
 * What the questions about a set of calls need of a request, whichever
 * provider it goes to.
 */
export type Demand = {
  /**
   * The estimated size of the longest single question: what a limit stated
   * for "the state plus the longest question" has to leave free.
   */
  longestQuestion: number
  /**
   * How many calls a request must at least be able to ask about.
   */
  batchCalls: number
  /**
   * The estimated size of the questions of that many calls, taking the
   * calls whose questions are longest.
   */
  batchTokens: number
  /**
   * The UTF-8 bytes the questions of one request may take: those of the
   * calls whose questions take the most bytes, `batchCalls` of them or as
   * many as the provider's question cap lets one request hold, whichever
   * is fewer. What a cap on the body in bytes has to leave free.
   */
  batchBytes: number
}

/**
 * The questions asked about each call.
 */
const QUESTIONS_PER_CALL = 2

/**
 * What a request costs around its state and questions: the `model` field
 * and the three key names, which are about the same in every wire format.
 */
const ENVELOPE_TOKENS = 32

/**
 * How many calls every request must have room to ask about, beside the
 * state. Each request carries the whole state, so a state allowed to fill
 * the request leaves room for one call's questions at a time, and the state
 * is then paid for once per call instead of once per batch.
 */
const MIN_CALLS_PER_REQUEST = 16

/**
 * The most requests one compaction sends. The state rides in every one of
 * them, so this bounds what a compaction can cost at this many times the
 * state; a conversation that would need more is left to the built-in
 * summary.
 */
const MAX_REQUESTS = 16

/**
 * How many requests are in flight at once. Waiting on a request is not
 * charged to the hook, so there is no need to send every batch at the same
 * moment, which is what a provider's rate limit is most likely to refuse.
 */
const CONCURRENT_REQUESTS = 3

/**
 * The share of a provider's documented limits a budget may reach. The token
 * estimate is made without a tokenizer and its weights were fitted to one
 * model, so a budget right at a limit could be over it by the provider's
 * own count, and a provider may cut what is over without saying so.
 */
export const LIMIT_SHARE = 0.85

/**
 * A result is left whole unless cutting it saves more than the note that
 * replaces its tail costs.
 */
const NOTE_ROOM = 120

/**
 * The scores a pinned call is reported with: it was not asked about, and it
 * stays whole.
 */
const UNASKED: Scores = { keepCall: 1, keepResult: 1 }

/**
 * The id of the question whether a call should stay.
 */
function callQuestionId(call: Call): string {
  return `call_${call.id}`
}

/**
 * The id of the question whether a call's whole output should stay.
 */
function resultQuestionId(call: Call): string {
  return `result_${call.id}`
}

/**
 * What is asked about a single call, as two questions. They are separate
 * because the answers differ in practice: that a file was read can matter
 * long after its contents stopped mattering.
 *
 * The rubric they are read under is in the state's `context`, sent once.
 *
 * @returns its two `noul` questions, by id
 */
export function questionsOf(call: Call): Questions {
  const named = `tool call ${call.id} (${call.tool})`
  const outcome = call.isError ? 'an error, ' : ''

  return {
    [callQuestionId(call)]: {
      type: 'noul',
      instructions:
        `Does the assistant still need to know that it made ${named}, and ` +
        'with which input, to carry on with the goal?',
    },
    [resultQuestionId(call)]: {
      type: 'noul',
      instructions:
        `Does the complete output of ${named}, ${outcome}` +
        `${call.resultChars} characters long, have to stay word for word ` +
        'because the assistant still relies on its content and running the ' +
        'tool again would not bring it back?',
    },
  }
}

/**
 * The estimated size of each of a call's questions and of the two together,
 * as they ride in a request body written in the route's wire format, with
 * what the provider counts for each question beyond its text; and the UTF-8
 * bytes of the two, each with the comma after it.
 */
function questionTokensOf(
  call: Call,
  wire: Wire,
): { both: number; longest: number; bytes: number } {
  let both = 0
  let longest = 0
  let bytes = 0

  for (const [id, question] of Object.entries(questionsOf(call))) {
    const json = wire.questionJsonOf(id, question)
    const tokens = estimatedTokensOf(json) + 1 + wire.tokensPerQuestion

    both += tokens
    longest = Math.max(longest, tokens)
    bytes += bytesOf(json) + 1
  }

  return { both, longest, bytes }
}

/**
 * The sum of the `count` largest of some sizes.
 */
function largestOf(sizes: readonly number[], count: number): number {
  return [...sizes]
    .sort((a, b) => b - a)
    .slice(0, count)
    .reduce((sum, size) => sum + size, 0)
}

/**
 * Measures what the questions about the calls need of a request: the
 * longest single question, and the questions of `MIN_CALLS_PER_REQUEST`
 * calls, or of all of them when there are fewer. The calls with the longest
 * questions are the ones counted, so the room set aside holds whichever
 * calls end up in a batch together.
 *
 * @param calls the calls that will be asked about
 * @param wire the wire format the questions are written in
 * @param maxQuestions the provider's cap on the questions of one request,
 * when it has one; it bounds only the bytes set aside
 * @returns the demand, all zero when there are no calls
 */
export function demandOf(
  calls: readonly Call[],
  wire: Wire,
  maxQuestions?: number,
): Demand {
  const sizes = calls.map(call => questionTokensOf(call, wire))
  const batchCalls = Math.min(MIN_CALLS_PER_REQUEST, sizes.length)
  const byteCalls =
    maxQuestions === undefined
      ? batchCalls
      : Math.min(batchCalls, Math.floor(maxQuestions / QUESTIONS_PER_CALL))

  return {
    longestQuestion: sizes.reduce(
      (longest, size) => Math.max(longest, size.longest),
      0,
    ),
    batchCalls,
    batchTokens: largestOf(
      sizes.map(size => size.both),
      batchCalls,
    ),
    batchBytes: largestOf(
      sizes.map(size => size.bytes),
      byteCalls,
    ),
  }
}

/**
 * Holds the person's budgets against a provider's limits and against each
 * other.
 *
 * A budget above `LIMIT_SHARE` of a documented limit is lowered to it rather
 * than trusted. The state is further held to what the request leaves once
 * the questions of a batch are set aside: a state that filled the request
 * would be sent again for every single call.
 *
 * @param want the configured budgets
 * @param limits the provider's documented limits
 * @param demand what the questions need of a request
 * @returns the budget one request is held to; throws when the request has
 * no room for a state beside one batch of questions
 */
export function budgetOf(
  want: { maxStateTokens: number; maxRequestTokens: number },
  limits: Limits,
  demand: Demand,
): Budget {
  const requestTokens = Math.min(
    want.maxRequestTokens,
    Math.floor(limits.maxRequestTokens * LIMIT_SHARE),
  )
  const beside = requestTokens - ENVELOPE_TOKENS - demand.batchTokens

  if (beside < 1) {
    throw new Error(
      `a request of ${requestTokens} tokens has no room for a state beside ` +
        `the questions of ${demand.batchCalls} ` +
        `${demand.batchCalls === 1 ? 'call' : 'calls'}, which take about ` +
        `${demand.batchTokens}`,
    )
  }

  const budget: Budget = {
    stateTokens: Math.min(
      want.maxStateTokens,
      Math.floor(limits.maxStateTokens * LIMIT_SHARE) - demand.longestQuestion,
      beside,
    ),
    requestTokens,
  }

  if (limits.maxQuestions !== undefined) {
    budget.questions = limits.maxQuestions
  }

  return budget
}

/**
 * Splits the calls into batches, each of which fits one request beside the
 * state under both the token budget and the provider's question count.
 *
 * The state is never split: every batch is asked against all of it, so the
 * only thing that varies between requests is which calls they ask about.
 *
 * @param calls the calls to ask about, in order
 * @param stateTokens the estimated size of the fitted state
 * @param budget what one request may hold
 * @param wire the wire format the questions are written in
 * @returns the batches, in order; throws when the state leaves room for not
 * even one call's questions, and when there would be more batches than
 * `MAX_REQUESTS`
 */
export function batchesOf(
  calls: readonly Call[],
  stateTokens: number,
  budget: Budget,
  wire: Wire,
): Call[][] {
  const room = budget.requestTokens - stateTokens - ENVELOPE_TOKENS
  const byteRoom =
    budget.bytes === undefined
      ? Infinity
      : budget.bytes.limit - budget.bytes.state
  const mostCalls =
    budget.questions === undefined
      ? Infinity
      : Math.floor(budget.questions / QUESTIONS_PER_CALL)

  if (mostCalls < 1) {
    throw new Error(
      `a request may hold ${budget.questions} questions, fewer than the ` +
        `${QUESTIONS_PER_CALL} one call needs`,
    )
  }

  const batches: Call[][] = []
  let batch: Call[] = []
  let used = 0
  let usedBytes = 0

  for (const call of calls) {
    const { both, bytes } = questionTokensOf(call, wire)

    if (both > room) {
      throw new Error(
        `no question fits beside the state: the state takes about ` +
          `${stateTokens} of the ${budget.requestTokens} tokens a request ` +
          'may hold',
      )
    }

    if (bytes > byteRoom) {
      throw new Error(
        `no question fits beside the state: the request takes ` +
          `${budget.bytes?.state} of the ${budget.bytes?.limit} bytes it ` +
          'may hold before any question',
      )
    }

    if (
      batch.length >= mostCalls ||
      used + both > room ||
      usedBytes + bytes > byteRoom
    ) {
      batches.push(batch)
      batch = []
      used = 0
      usedBytes = 0
    }

    batch.push(call)
    used += both
    usedBytes += bytes
  }

  if (batch.length > 0) {
    batches.push(batch)
  }

  if (batches.length > MAX_REQUESTS) {
    throw new Error(
      `asking about ${calls.length} tool calls would take ` +
        `${batches.length} requests, and one compaction sends at most ` +
        `${MAX_REQUESTS}`,
    )
  }

  return batches
}

/**
 * Turns the two probabilities into what happens to the call. The result
 * question is the stronger claim, so it is read first: a result worth
 * keeping keeps its call with it.
 *
 * @param threshold the probability from which an item is kept
 */
export function decide(
  call: Call,
  scores: Scores,
  threshold: number,
): Decision {
  if (call.isPinned) {
    return { call, ...scores, action: 'pinned' }
  }

  if (scores.keepResult >= threshold) {
    return { call, ...scores, action: 'keep' }
  }

  if (scores.keepCall >= threshold) {
    return { call, ...scores, action: 'truncate' }
  }

  return { call, ...scores, action: 'drop' }
}

/**
 * Says whether cutting a text of this length to its head removes more than
 * the note that then stands for the rest adds.
 */
function isWorthCutting(chars: number, headChars: number): boolean {
  return chars > headChars + NOTE_ROOM
}

/**
 * A result text cut to its head, with one line saying what was done and by
 * what, so the assistant reading it later knows the rest existed and how to
 * get it back. A text too short for the cut to save anything is left as is.
 */
function cut(text: string, headChars: number, isError: boolean): string {
  if (!isWorthCutting(text.length, headChars)) {
    return text
  }

  const head = headOf(text, headChars)
  const kind = isError ? 'error output' : 'output'

  return (
    `${head}${head === '' ? '' : '\n'}[decision-compaction removed ` +
    `${text.length - head.length} more characters of this tool ${kind}; ` +
    'run the tool again if they are needed]'
  )
}

/**
 * A result with its text cut, or the same object when nothing was cut. The
 * stored record is left off a cut result: it holds the full output.
 */
function cutResult(
  result: ToolResultSummary,
  headChars: number,
): ToolResultSummary {
  const { tool_use_id, isError } = result
  const text = cut(result.text, headChars, isError)

  if (text === result.text) {
    return result
  }

  return { tool_use_id, text, isError }
}

/**
 * A tool use whose mirrored outcome is cut like its result, or the same
 * object when nothing was cut. Only used inside a message that is rebuilt
 * anyway, so the copy and the result it mirrors agree.
 */
function cutUse(use: ToolUseSummary, headChars: number): ToolUseSummary {
  if (use.text === undefined) {
    return use
  }

  const text = cut(use.text, headChars, use.isError === true)

  if (text === use.text) {
    return use
  }

  const { result: _record, ...kept } = use

  return { ...kept, text }
}

/**
 * Carries the decisions out on the conversation.
 *
 * A message nothing touched is returned as the very object it came in as, so
 * it still carries the engine's `handle` and stands whole. A changed message
 * is a new object with no `handle`, which the engine builds from its role,
 * text and tool blocks; because that loses whatever else the original held,
 * a message is rebuilt only when one of its own blocks changed. A dropped
 * call takes its result with it, so no result is left without its call, and
 * a message left with no text and no block is removed.
 *
 * @param messages the conversation
 * @param decisions what was decided for each paired call
 * @param headChars how much of a truncated result stays
 * @returns the conversation afterwards, oldest first
 */
export function rebuild(
  messages: readonly SessionMessage[],
  decisions: readonly Decision[],
  headChars: number,
): SessionMessage[] {
  const fate = new Map<string, 'truncate' | 'drop'>()

  for (const { call, action } of decisions) {
    if (action === 'truncate' || action === 'drop') {
      fate.set(call.toolUseId, action)
    }
  }

  const rebuilt: SessionMessage[] = []

  for (const message of messages) {
    const given = message.toolResults ?? []
    const uses = message.toolUses.filter(
      use => fate.get(use.tool_use_id) !== 'drop',
    )
    const results = given
      .filter(result => fate.get(result.tool_use_id) !== 'drop')
      .map(result =>
        fate.get(result.tool_use_id) === 'truncate'
          ? cutResult(result, headChars)
          : result,
      )
    const isUntouched =
      uses.length === message.toolUses.length &&
      results.length === given.length &&
      results.every((result, index) => result === given[index])

    if (isUntouched) {
      rebuilt.push(message)
      continue
    }

    const isEmptied =
      uses.length + results.length === 0 && message.text.trim() === ''

    if (!isEmptied) {
      rebuilt.push({
        role: message.role,
        text: message.text,
        toolUses: uses.map(use =>
          fate.get(use.tool_use_id) === 'truncate'
            ? cutUse(use, headChars)
            : use,
        ),
        ...(results.length > 0 ? { toolResults: results } : {}),
      })
    }
  }

  return rebuilt
}

/**
 * The size of a tool input as the model reads it. An input that cannot be
 * serialised has no size to compare, and counts as nothing.
 */
function inputCharsOf(use: ToolUseSummary): number {
  try {
    return (JSON.stringify(use.input) ?? '').length
  } catch {
    return 0
  }
}

/**
 * The characters a message holds for the model: its text, its tool inputs
 * and its tool results. The outcome mirrored on a tool use is not counted,
 * since the result block already is.
 */
function charsOf(message: SessionMessage): number {
  const inputs = message.toolUses.reduce(
    (sum, use) => sum + inputCharsOf(use),
    0,
  )
  const results = (message.toolResults ?? []).reduce(
    (sum, result) => sum + result.text.length,
    0,
  )

  return message.text.length + inputs + results
}

function totalChars(messages: readonly SessionMessage[]): number {
  return messages.reduce((chars, message) => chars + charsOf(message), 0)
}

/**
 * The share of the conversation's characters a compaction removed.
 *
 * @returns a ratio from 0 to 1; 0 for an empty conversation
 */
export function reductionOf(
  outcome: Pick<Outcome, 'charsBefore' | 'charsAfter'>,
): number {
  return outcome.charsBefore === 0
    ? 0
    : (outcome.charsBefore - outcome.charsAfter) / outcome.charsBefore
}

/**
 * One batch as it came back: the reply and, for every call of the batch,
 * the two probabilities read from it.
 */
type Judged = {
  reply: Reply
  scores: [Call, Scores][]
}

/**
 * Puts one batch to the provider and reads both answers of every call in
 * it. A reply that lacks one of them fails the batch: a call nobody answered
 * for must not be decided by a default.
 */
async function judge(
  batch: readonly Call[],
  state: unknown,
  ask: Ask,
): Promise<Judged> {
  const reply = await ask(
    state,
    Object.fromEntries(
      batch.flatMap(call => Object.entries(questionsOf(call))),
    ),
  )

  return {
    reply,
    scores: batch.map(call => [
      call,
      {
        keepCall: noulOf(reply, callQuestionId(call)),
        keepResult: noulOf(reply, resultQuestionId(call)),
      },
    ]),
  }
}

/**
 * The outcome when there is nothing to ask about: the conversation as it is.
 *
 * @param messages the conversation
 * @param calls its paired calls, all of them pinned
 * @returns an outcome with no request made
 */
export function untouched(
  messages: readonly SessionMessage[],
  calls: readonly Call[],
): Outcome {
  const chars = totalChars(messages)

  return {
    messages: [...messages],
    decisions: calls.map(call => decide(call, UNASKED, 0)),
    charsBefore: chars,
    charsAfter: chars,
    stateTokens: 0,
    requests: 0,
    reported: {},
    shortened: 0,
  }
}

/**
 * Runs `work` over the items with at most `width` of them under way at a
 * time, and resolves with the results in the items' order, whichever order
 * they came back in. The first failure rejects the whole and starts nothing
 * further; `onFailure` hears of it at once, so that the caller can stop what
 * is still under way.
 */
async function inTurns<Item, Result>(
  items: readonly Item[],
  width: number,
  work: (item: Item) => Promise<Result>,
  onFailure: (reason: unknown) => void,
): Promise<Result[]> {
  const results: Result[] = []
  let next = 0
  let hasFailed = false

  const worker = async () => {
    while (!hasFailed && next < items.length) {
      const index = next++

      try {
        results[index] = await work(items[index] as Item)
      } catch (error) {
        hasFailed = true
        onFailure(error)

        throw error
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, worker),
  )

  return results
}

/**
 * Asks about every candidate call and applies the answers to the
 * conversation. The batches go out `CONCURRENT_REQUESTS` at a time, each
 * with the whole state, and each call is decided by the answers of its own
 * batch, in whatever order the batches come back. One batch failing fails
 * the compaction, since half the answers decide nothing; no batch is sent
 * after it, and `halt` is told at once so the others can be abandoned.
 *
 * @param messages the conversation
 * @param calls its paired calls, pinned ones included
 * @param fitted the state, already fitted to the budget, with its size as
 * the route's wire format carries it
 * @param ask how a batch is sent
 * @param settings the budget, the route's wire format, the keep threshold,
 * the truncation length, and `halt`, which hears the reason the moment a
 * batch fails
 */
export async function compact(
  messages: readonly SessionMessage[],
  calls: readonly Call[],
  fitted: Fitted,
  ask: Ask,
  settings: {
    budget: Budget
    wire: Wire
    keepThreshold: number
    truncateHeadChars: number
    halt?: (reason: Error) => void
  },
): Promise<Outcome> {
  const batches = batchesOf(
    calls.filter(call => !call.isPinned),
    fitted.tokens,
    settings.budget,
    settings.wire,
  )
  const answered = await inTurns(
    batches,
    CONCURRENT_REQUESTS,
    batch => judge(batch, fitted.state, ask),
    reason =>
      settings.halt?.(
        reason instanceof Error ? reason : new Error(String(reason)),
      ),
  )
  const scores = new Map<Call, Scores>()
  const reported: Reported = {}

  for (const { scores: judged, reply } of answered) {
    for (const [call, value] of judged) {
      scores.set(call, value)
    }

    if (reply.usage.input_tokens !== undefined) {
      reported.inputTokens = Math.max(
        reported.inputTokens ?? 0,
        reply.usage.input_tokens,
      )
    }

    if (reply.usage.cost !== undefined) {
      reported.cost = (reported.cost ?? 0) + reply.usage.cost
    }
  }

  const decisions = calls.map(call =>
    decide(call, scores.get(call) ?? UNASKED, settings.keepThreshold),
  )
  const kept = rebuild(messages, decisions, settings.truncateHeadChars)

  return {
    messages: kept,
    decisions,
    charsBefore: totalChars(messages),
    charsAfter: totalChars(kept),
    stateTokens: fitted.tokens,
    stage: fitted.stage,
    requests: batches.length,
    reported,
    shortened: decisions.filter(
      ({ call, action }) =>
        action === 'truncate' &&
        isWorthCutting(call.resultChars, settings.truncateHeadChars),
    ).length,
  }
}
