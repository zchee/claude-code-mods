import type { SessionMessage, ToolUseSummary } from 'claude-code'

import { bytesOf } from './systemone'
import type { Wire } from './systemone'

/**
 * One tool call with the result that answers it, found by `tool_use_id`.
 */
export type Call = {
  /**
   * A name of a few characters (`t1`, `t2`, ...) that stands for the call in
   * the state and in the question ids, where the engine's own `tool_use_id`
   * would be paid for, character by character, in every request.
   */
  id: string
  toolUseId: string
  tool: string
  input: Record<string, unknown>
  /**
   * Where in the conversation the assistant made the call.
   */
  callIndex: number
  /**
   * Where in the conversation the answer to the call arrived.
   */
  resultIndex: number
  resultChars: number
  isError: boolean
  /**
   * True when the call is shown to the model but never asked about, so it
   * stays exactly as it is. That holds when either of its two messages is
   * one that is never changed, and when its `tool_use_id` is not unique in
   * the conversation: a decision is applied by that id, so one taken for
   * such a call would also reach the other blocks that carry it.
   */
  isPinned: boolean
}

/**
 * A call as the state shows it: its input, and a note in place of its output.
 */
export type CallNote = {
  id: string
  tool: string
  input: string
  result: string
}

/**
 * One message of the conversation as the state shows it. `calls` holds
 * notes, or one line per call once the state had to shrink that far.
 */
type Entry = {
  at: number
  role: SessionMessage['role']
  text: string
  calls?: CallNote[] | string[]
}

/**
 * What every request sends as `state`.
 */
export type State = {
  context: string
  goal: string
  conversation: Entry[]
}

/**
 * How far the state had to be reduced before it fitted, for the report.
 */
export type Stage =
  | 'whole'
  | 'result heads dropped'
  | 'inputs shortened'
  | 'long texts cut in the middle'
  | 'old texts replaced by their length'
  | 'old calls on one line'
  | 'old call-free messages omitted'
  | 'rows of old calls joined'

/**
 * A state that fits its budget.
 */
export type Fitted = {
  state: State
  /**
   * The estimated size of the serialised state, as the wire format it was
   * fitted for carries it.
   */
  tokens: number
  stage: Stage
}

/**
 * What the fitting needs to know.
 */
type FitNeed = {
  maxStateTokens: number
  preserveRecentMessages: number
  goal: string
  /**
   * The wire format the state is sent in. It is measured as that format
   * carries it: a format that escapes the state inside a string makes it
   * larger than its own JSON.
   */
  wire: Wire
  /**
   * For a route that caps the request body in bytes: the UTF-8 bytes the
   * body may take besides the questions it must leave room for, and the
   * bytes it takes around a state, questions left out. The state is then
   * held to both budgets; absent, it is fitted in tokens alone.
   */
  bytes?: { limit: number; besideOf: (state: State) => number }
  /**
   * The frame the questions are read in, in place of `CONTEXT`. A benchmark
   * sets it to compare wordings; every compaction leaves it unset. It is
   * part of the state, so the state is fitted with it.
   */
  context?: string
  /**
   * How many characters of each call's output the state shows, at most
   * `RESULT_HEAD_MAX`; absent or 0, it shows none. The heads are the first
   * detail given up when the state is over its budget.
   */
  resultHead?: number
}

/**
 * The most characters of a call's output the state shows.
 */
export const RESULT_HEAD_MAX = 1000

/**
 * The characters of each call's output a compaction shows: none, until a
 * measurement shows that showing the start of each output improves the
 * decisions enough to pay for the larger state.
 */
export const DEFAULT_RESULT_HEAD = 0

/**
 * The frame every question is read in. It carries the rubric once, so the
 * per-call questions can stay short: they are repeated for every call.
 *
 * It ties the goal to the newest prompt, which is what decides the next
 * step, and does not say that the assistant can run any tool again: that
 * sentence invited a "no" for every file read. Measured on 2026-11-03
 * against a labelled corpus, the context with it, and the questions of its
 * time, scored a median of 0.26 for the call and 0.10 for the result on
 * calls a reference keeps and dropped nearly every call on every provider;
 * this one, with the questions now asked, scores 0.45 and 0.20.
 *
 * It is held in two parts, around the sentence that says how much of each
 * output the state shows; `contextOf` puts them together.
 */
const CONTEXT_START =
  'This is the transcript of a coding assistant session whose context ' +
  'window is nearly full. To free space, old tool calls and their outputs ' +
  'are being removed; nothing is summarised or reworded. `conversation` ' +
  'lists the messages in order, oldest first. A tool call appears under ' +
  '`calls` with its `id` and its input. '
const CONTEXT_END =
  ' Long texts may be shortened and old messages may be missing. `goal` ' +
  'says what the assistant is working on, and what the assistant will do ' +
  'next depends on the newest prompt in it. Each question is about one ' +
  'tool call, named by its `id`.'

/**
 * The context for a state that shows `resultHead` characters of each
 * output: with none, it says the output is not shown; with some, that the
 * note says how the output starts.
 *
 * @param resultHead the characters of each output the state shows
 * @returns the context
 */
export function contextOf(resultHead: number): string {
  const said =
    resultHead > 0
      ? 'Its output is shown in part: `result` says whether it succeeded, ' +
        'how long it was, and how it starts.'
      : 'Its output is not shown: `result` only says whether it succeeded ' +
        'and how long it was.'

  return `${CONTEXT_START}${said}${CONTEXT_END}`
}

/**
 * The successive caps on a call's serialised input, in characters.
 */
const INPUT_CAPS = [1000, 240, 64] as const

/**
 * What stays of a long text when it is abridged: its start and its end.
 */
const KEPT_START_CHARS = 400
const KEPT_END_CHARS = 160

/**
 * A text is abridged only past this length, so the note that replaces its
 * middle is always shorter than what it replaces.
 */
const LONG_TEXT = KEPT_START_CHARS + KEPT_END_CHARS + 48

/**
 * The longest the note standing for a collapsed text gets; a text no longer
 * than this is left alone, since the note would not be shorter.
 */
const COLLAPSED_NOTE_CHARS = 48

const GOAL_CHARS = 2000
const PROMPT_CHARS = 500
const GOAL_PROMPTS = 3

/**
 * Letters one token is assumed to cover inside a word.
 */
const LETTERS_PER_TOKEN = 6

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * Estimates how many tokens a provider will count for a text, with no
 * tokenizer: a hooks module cannot load one.
 *
 * Each character is weighed by its class:
 *
 * - ASCII letters: 1 token for each started group of `LETTERS_PER_TOKEN`
 *   in an unbroken run of them;
 * - ASCII digits: 0.5 each;
 * - other visible ASCII characters: 0.9 each;
 * - characters beyond ASCII: 1 each, which is about what CJK text comes to;
 * - white space: nothing.
 *
 * The weights follow the design this mod is modelled on, which reports them
 * landing a little above Jev's own count; they are an estimate, so the
 * budgets they are compared with must leave headroom.
 */
export function estimatedTokensOf(text: string): number {
  // Counted in tenths of a token so the sum stays in whole numbers: adding
  // 0.9 repeatedly drifts, and the drift would move the rounded result.
  let tenths = 0
  let letters = 0

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)

    if (isLetter(code)) {
      letters++
      continue
    }

    tenths += Math.ceil(letters / LETTERS_PER_TOKEN) * 10
    letters = 0

    if (isDigit(code)) {
      tenths += 5
    } else if (code > 127) {
      tenths += 10
    } else if (code > 32) {
      tenths += 9
    }
  }

  tenths += Math.ceil(letters / LETTERS_PER_TOKEN) * 10

  return Math.ceil(tenths / 10)
}

/**
 * The first `count` characters of a text, never ending between the two
 * halves of a surrogate pair: a lone half does not survive JSON transport.
 *
 * @param count how many characters at most
 * @returns the start of the text
 */
export function headOf(text: string, count: number): string {
  const end = Math.max(0, Math.min(count, text.length))

  return end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1))
    ? text.slice(0, end - 1)
    : text.slice(0, end)
}

/**
 * The last `count` characters of a text, never starting between the two
 * halves of a surrogate pair.
 */
function tailOf(text: string, count: number): string {
  const start = Math.max(0, text.length - count)

  return start > 0 && isHighSurrogate(text.charCodeAt(start - 1))
    ? text.slice(start + 1)
    : text.slice(start)
}

/**
 * A text cut to a length, with a mark where it was cut.
 */
function clipped(text: string, limit: number): string {
  if (text.length > limit) {
    return `${headOf(text, limit - 1)}…`
  }

  return text
}

/**
 * A long text with its middle replaced by a note of how much is missing.
 */
function abridged(text: string): string {
  const head = headOf(text, KEPT_START_CHARS)
  const tail = tailOf(text, KEPT_END_CHARS)
  const missing = text.length - head.length - tail.length

  return `${head}\n[${missing} characters left out]\n${tail}`
}

/**
 * Says whether a message is one that is never changed: the first, which
 * usually states the task, and the newest `recent`, which the assistant is
 * still working from.
 *
 * @param index the message's index
 * @param total how many messages the conversation has
 * @param recent how many of the newest are kept as they are
 * @returns true when the message is pinned
 */
function isPinnedIndex(
  index: number,
  total: number,
  recent: number,
): boolean {
  // 1 for the newest message, 2 for the one before it, and so on.
  const fromNewest = total - index

  return index === 0 || fromNewest <= recent
}

/**
 * One tool use and where it stands: the message that holds it, and its
 * place among all the tool uses of the conversation.
 */
type Site = {
  use: ToolUseSummary
  at: number
  order: number
}

/**
 * Lists the calls that have been answered, in the order they were made,
 * each joined to its answer through the `tool_use_id` the two share. A call
 * still waiting for its answer is not listed: removing it would leave the
 * answer, when it arrives, with nothing to belong to.
 *
 * An id is expected on one tool use and on one result. Where it stands on
 * more than one of either, every call that carries it is marked as not to
 * be judged: what is decided for a call is applied by its id, so it would
 * reach each block with that id, one in a pinned message included. Such a
 * call is joined to the first result with its id.
 *
 * @param messages the conversation
 * @param recent how many of the newest messages are pinned
 * @returns the paired calls, the ones not to be judged included
 */
export function pairCalls(
  messages: readonly SessionMessage[],
  recent: number,
): Call[] {
  const sites = new Map<string, Site[]>()
  let order = 0

  for (const [at, message] of messages.entries()) {
    for (const use of message.toolUses) {
      const site: Site = { use, at, order: order++ }
      const sharing = sites.get(use.tool_use_id)

      if (sharing === undefined) {
        sites.set(use.tool_use_id, [site])
      } else {
        sharing.push(site)
      }
    }
  }

  const answered = new Set<string>()
  const repeated = new Set<string>()
  const pairs: {
    site: Site
    resultIndex: number
    resultChars: number
    isError: boolean
  }[] = []

  for (const [resultIndex, message] of messages.entries()) {
    for (const { tool_use_id: id, text, isError } of message.toolResults ??
      []) {
      if (answered.has(id)) {
        repeated.add(id)
        continue
      }

      answered.add(id)

      for (const site of sites.get(id) ?? []) {
        pairs.push({ site, resultIndex, resultChars: text.length, isError })
      }
    }
  }

  const isKept = (at: number) => isPinnedIndex(at, messages.length, recent)
  const isShared = (id: string) =>
    repeated.has(id) || (sites.get(id)?.length ?? 0) > 1

  return pairs
    .sort((a, b) => a.site.order - b.site.order)
    .map(({ site, resultIndex, resultChars, isError }, index) => ({
      id: `t${index + 1}`,
      toolUseId: site.use.tool_use_id,
      tool: site.use.tool,
      input: site.use.input,
      callIndex: site.at,
      resultIndex,
      resultChars,
      isError,
      isPinned:
        isShared(site.use.tool_use_id) ||
        isKept(site.at) ||
        isKept(resultIndex),
    }))
}

/**
 * Says whether a message is something the person typed: a user message
 * with text that brings no tool result.
 */
function isPrompt(message: SessionMessage): boolean {
  return (
    message.role === 'user' &&
    (message.toolResults?.length ?? 0) === 0 &&
    message.text.trim() !== ''
  )
}

/**
 * Says what the assistant is working on: the instructions given with the
 * compaction when there are any (the text typed after `/compact`, or a
 * plugin's), since they were written for exactly this; otherwise the last
 * prompts the person typed.
 *
 * @param messages the conversation
 * @param instructions the compaction's instructions, when given
 * @returns the goal text, possibly empty
 */
export function goalOf(
  messages: readonly SessionMessage[],
  instructions?: string,
): string {
  const stated = instructions?.trim() ?? ''

  if (stated !== '') {
    return clipped(stated, GOAL_CHARS)
  }

  // Read from the newest message back, and stop at the first few prompts:
  // the conversation before them has no part in the goal.
  const prompts: string[] = []

  for (
    let at = messages.length - 1;
    at >= 0 && prompts.length < GOAL_PROMPTS;
    at--
  ) {
    const message = messages[at]

    if (message !== undefined && isPrompt(message)) {
      prompts.unshift(clipped(message.text.trim(), PROMPT_CHARS))
    }
  }

  return prompts.join('\n')
}

function statusOf(call: Call): string {
  return call.isError ? 'error' : 'ok'
}

/**
 * A call's input as JSON text. An input that cannot be serialised (a cycle)
 * is named rather than allowed to fail the whole compaction.
 */
function inputJsonOf(call: Call): string {
  try {
    return JSON.stringify(call.input) ?? '{}'
  } catch {
    return '[input that cannot be shown]'
  }
}

/**
 * One argument of a call as `name=value` on a single line: a string as it
 * is, any other value as its JSON, every stretch of white space as one
 * space.
 */
function argumentOf(name: string, value: unknown): string {
  const shown =
    typeof value === 'string' ? value : String(JSON.stringify(value))

  return `${name}=${shown.replace(/\s+/g, ' ')}`
}

/**
 * A call on one line, for when a structured note costs too much. Its parts,
 * a space apart: the id, the tool with its arguments in brackets (held to
 * the tightest input cap), the outcome, and the length of the result.
 */
function lineOf(call: Call): string {
  const said = Object.keys(call.input)
    .map(name => argumentOf(name, call.input[name]))
    .join(' ')

  return [
    call.id,
    `${call.tool}(${clipped(said, INPUT_CAPS[2])})`,
    statusOf(call),
    `${call.resultChars}ch`,
  ].join(' ')
}

/**
 * One entry of the working list: the entry, what it costs, and whether it
 * may be reduced.
 */
type Slot = {
  entry: Entry
  tokens: number
  /**
   * What the entry takes in UTF-8 bytes, comma included; 0 when the state
   * has no byte budget.
   */
  bytes: number
  isOld: boolean
  isOut: boolean
}

/**
 * One reduction: the stage it reports, the slots it visits in order, which
 * of them it applies to, and what it does to one.
 */
type Pass = {
  stage: Stage
  over: readonly Slot[]
  applies: (slot: Slot) => boolean
  reduce: (slot: Slot) => void
}

/**
 * Where several entries in a row hold nothing but one-line calls, gives the
 * lines of all of them to the first and drops the rest. The keys of an
 * entry are then paid for once for the whole row, and every line still
 * starts with the id its questions name. `reweigh` measures a slot again
 * once its entry has grown.
 */
function folded(
  slots: readonly Slot[],
  reweigh: (slot: Slot) => void,
): Slot[] {
  const isFoldable = (slot: Slot) =>
    slot.isOld &&
    slot.entry.text === '' &&
    typeof slot.entry.calls?.[0] === 'string'
  const kept: Slot[] = []
  const grown = new Set<Slot>()

  for (const slot of slots) {
    const last = kept.at(-1)

    if (
      last !== undefined &&
      isFoldable(last) &&
      isFoldable(slot) &&
      last.entry.role === slot.entry.role
    ) {
      // The first merge of a run gives the entry a list of its own; every
      // later one appends to it. Copying the list or weighing the entry per
      // merge would cost the square of the run's length, and a session of
      // nothing but tool calls is one long run.
      if (!grown.has(last)) {
        last.entry.calls = [...(last.entry.calls as string[])]
        grown.add(last)
      }

      ;(last.entry.calls as string[]).push(...(slot.entry.calls as string[]))
      continue
    }

    kept.push(slot)
  }

  for (const slot of grown) {
    reweigh(slot)
  }

  return kept
}

/**
 * Describes the conversation to the decision model within `maxStateTokens`.
 *
 * The model judges better the more of the session it can see, so the state
 * starts as everything and gives up detail only while its estimate is over
 * the budget, cheapest loss first, and stops the moment it is under. Each
 * rung below is tried only when the one above was not enough:
 *
 * 1. the start of each call's output, when `resultHead` shows one;
 * 2. a cap on the JSON of each call's input, tightened twice;
 * 3. the middle of every long text, in old messages before pinned ones;
 * 4. the text of an old message, of which only its length is then stated;
 * 5. the structure of an old call, written as a single line instead;
 * 6. old messages in which no call was made;
 * 7. the separate entries of neighbouring old messages that hold only calls.
 *
 * The estimate is checked here, whichever provider is asked, because a
 * provider may cut a state that is too long without saying so. Where the
 * route caps the body in bytes, the state is held to that budget too, on
 * the same rungs: text with many letters to a token takes more bytes than
 * the token budget assumes. A conversation still over either budget on the
 * last rung is refused by throwing.
 *
 * @param messages the conversation
 * @param calls its paired calls, as `pairCalls` answered them
 * @param need the budget, the pinning, the goal, the wire format and, when
 * given, the context in place of the usual one and how much of each output
 * to show
 * @returns the fitted state, its estimated size and the stage reached
 */
export function stateWithin(
  messages: readonly SessionMessage[],
  calls: readonly Call[],
  need: FitNeed,
): Fitted {
  const resultHead = Math.min(
    Math.max(0, Math.floor(need.resultHead ?? 0)),
    RESULT_HEAD_MAX,
  )
  // The context follows the notes: once the heads are dropped it says the
  // output is not shown, so such a state is the one built without heads.
  // It is set with every layout, and so is what the frame around the
  // entries costs.
  let context = ''
  const frame = (conversation: Entry[]): State => ({
    context,
    goal: need.goal,
    conversation,
  })
  const tokensOf = (state: State) =>
    estimatedTokensOf(need.wire.stateJsonOf(JSON.stringify(state)))
  const { bytes } = need
  let frameTokens = 0
  let frameBytes = 0
  const frameFor = (withHeads: boolean) => {
    context = need.context ?? contextOf(withHeads ? resultHead : 0)
    frameTokens = tokensOf(frame([]))
    frameBytes = bytes === undefined ? 0 : bytes.besideOf(frame([]))
  }
  // What an entry costs inside the list: its own JSON as the wire format
  // carries it and the comma after it, in tokens and in UTF-8 bytes. The
  // last entry has no comma, so a sum of these is over by one byte at most.
  const weigh = (entry: Entry): Pick<Slot, 'tokens' | 'bytes'> => {
    const json = need.wire.stateJsonOf(JSON.stringify(entry))

    return {
      tokens: estimatedTokensOf(json) + 1,
      bytes: bytes === undefined ? 0 : bytesOf(json) + 1,
    }
  }
  const inputs = new Map(calls.map(call => [call, inputJsonOf(call)]))
  // The output a call's note shows the start of: the first result with its
  // id, which is the one `pairCalls` joined it to. Read only when heads are
  // shown, so a state without them costs nothing more than before.
  const outputs = new Map<string, string>()

  if (resultHead > 0) {
    for (const call of calls) {
      const result = messages[call.resultIndex]?.toolResults?.find(
        candidate => candidate.tool_use_id === call.toolUseId,
      )

      if (result !== undefined && !outputs.has(call.toolUseId)) {
        outputs.set(call.toolUseId, result.text)
      }
    }
  }

  const noteOf = (call: Call, withHeads: boolean): string => {
    const said = `${statusOf(call)}, ${call.resultChars} characters`
    const text = withHeads ? outputs.get(call.toolUseId) : undefined

    if (text === undefined) {
      return `${said}, not shown`
    }

    if (text.length <= resultHead) {
      return `${said}, shown whole: ${text}`
    }

    const head = headOf(text, resultHead)

    return `${said}; first ${head.length}: ${head}`
  }
  const made = new Map<number, Call[]>()

  for (const call of calls) {
    made.set(call.callIndex, [...(made.get(call.callIndex) ?? []), call])
  }

  let slots: Slot[] = []
  let total = 0
  let totalBytes = 0

  const tally = () => {
    total = frameTokens
    totalBytes = frameBytes

    for (const slot of slots) {
      total += slot.tokens
      totalBytes += slot.bytes
    }
  }

  const lay = (inputCap: number, withHeads: boolean) => {
    frameFor(withHeads)
    slots = []

    messages.forEach((message, at) => {
      const own = made.get(at) ?? []

      if (message.text.trim() === '' && own.length === 0) {
        return
      }

      const entry: Entry = {
        at,
        role: message.role,
        text: message.text.trim() === '' ? '' : message.text,
      }

      if (own.length > 0) {
        entry.calls = own.map(call => ({
          id: call.id,
          tool: call.tool,
          input: clipped(inputs.get(call) ?? '', inputCap),
          result: noteOf(call, withHeads),
        }))
      }

      slots.push({
        entry,
        ...weigh(entry),
        isOld: !isPinnedIndex(at, messages.length, need.preserveRecentMessages),
        isOut: false,
      })
    })

    tally()
  }

  const fits = () =>
    total <= need.maxStateTokens &&
    (bytes === undefined || totalBytes <= bytes.limit)

  const fitted = (stage: Stage): Fitted => {
    const state = frame(
      slots.filter(slot => !slot.isOut).map(slot => slot.entry),
    )

    return { state, tokens: tokensOf(state), stage }
  }

  // The heads of the outputs go first, before any input is shortened: a
  // state without them is the one every compaction sent before they could
  // be shown.
  type Opening = [inputCap: number, withHeads: boolean, stage: Stage]
  const atWholeInputs: Opening[] =
    resultHead > 0
      ? [
          [INPUT_CAPS[0], true, 'whole'],
          [INPUT_CAPS[0], false, 'result heads dropped'],
        ]
      : [[INPUT_CAPS[0], false, 'whole']]
  const openings: Opening[] = [
    ...atWholeInputs,
    [INPUT_CAPS[1], false, 'inputs shortened'],
    [INPUT_CAPS[2], false, 'inputs shortened'],
  ]

  for (const [cap, withHeads, stage] of openings) {
    lay(cap, withHeads)

    if (fits()) {
      return fitted(stage)
    }
  }

  const old = slots.filter(slot => slot.isOld)
  const oldFirst = [...old, ...slots.filter(slot => !slot.isOld)]

  const passes: readonly Pass[] = [
    {
      stage: 'long texts cut in the middle',
      over: oldFirst,
      applies: slot => slot.entry.text.length > LONG_TEXT,
      reduce: slot => {
        slot.entry.text = abridged(slot.entry.text)
      },
    },
    {
      stage: 'old texts replaced by their length',
      over: old,
      applies: slot => slot.entry.text.length > COLLAPSED_NOTE_CHARS,
      reduce: slot => {
        const length = messages[slot.entry.at]?.text.length ?? 0

        slot.entry.text = `[${length} characters of text left out]`
      },
    },
    {
      stage: 'old calls on one line',
      over: old,
      applies: slot => slot.entry.calls !== undefined,
      reduce: slot => {
        slot.entry.calls = (made.get(slot.entry.at) ?? []).map(lineOf)
      },
    },
    {
      stage: 'old call-free messages omitted',
      over: old,
      applies: slot => slot.entry.calls === undefined,
      reduce: slot => {
        slot.isOut = true
      },
    },
  ]

  for (const pass of passes) {
    for (const slot of pass.over) {
      if (!pass.applies(slot)) {
        continue
      }

      pass.reduce(slot)

      const now = slot.isOut ? { tokens: 0, bytes: 0 } : weigh(slot.entry)

      total += now.tokens - slot.tokens
      totalBytes += now.bytes - slot.bytes
      slot.tokens = now.tokens
      slot.bytes = now.bytes

      if (fits()) {
        return fitted(pass.stage)
      }
    }
  }

  slots = folded(
    slots.filter(slot => !slot.isOut),
    slot => {
      Object.assign(slot, weigh(slot.entry))
    },
  )
  tally()

  if (fits()) {
    return fitted('rows of old calls joined')
  }

  if (total <= need.maxStateTokens && bytes !== undefined) {
    throw new Error(
      'the conversation does not fit the request body: about ' +
        `${totalBytes} bytes are left after every reduction and ` +
        `${bytes.limit} are allowed`,
    )
  }

  throw new Error(
    `the conversation does not fit the state budget: about ${total} tokens ` +
      `are left after every reduction and ${need.maxStateTokens} are allowed`,
  )
}
