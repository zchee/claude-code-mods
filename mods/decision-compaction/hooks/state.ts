import type { SessionMessage, ToolUseSummary } from 'claude-code'

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
export type Entry = {
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
   * The estimated size of the serialised state.
   */
  tokens: number
  stage: Stage
}

/**
 * What the fitting needs to know.
 */
export type FitNeed = {
  maxStateTokens: number
  preserveRecentMessages: number
  goal: string
}

/**
 * The frame every question is read in. It carries the rubric once, so the
 * per-call questions can stay short: they are repeated for every call.
 */
export const CONTEXT =
  'This is the transcript of a coding assistant session whose context ' +
  'window is nearly full. To free space, old tool calls and their outputs ' +
  'are being removed; nothing is summarised or reworded. `conversation` ' +
  'lists the messages in order, oldest first. A tool call appears under ' +
  '`calls` with its `id` and its input. Its output is not shown: `result` ' +
  'only says whether it succeeded and how long it was. Long texts may be ' +
  'shortened and old messages may be missing. `goal` says what the ' +
  'assistant is working on. Each question is about one tool call, named by ' +
  'its `id`. What is removed is gone for good, but the assistant can run ' +
  'any tool again and read any file again.'

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
 *
 * @param text the text
 * @returns the estimated token count
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
 * @param text the text
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
export function isPinnedIndex(
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
 * What an entry costs inside the list: its own JSON and the comma after it.
 */
function weigh(entry: Entry): number {
  return estimatedTokensOf(JSON.stringify(entry)) + 1
}

/**
 * Where several entries in a row hold nothing but one-line calls, gives the
 * lines of all of them to the first and drops the rest. The keys of an
 * entry are then paid for once for the whole row, and every line still
 * starts with the id its questions name.
 */
function folded(slots: readonly Slot[]): Slot[] {
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
    slot.tokens = weigh(slot.entry)
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
 * 1. a cap on the JSON of each call's input, tightened twice;
 * 2. the middle of every long text, in old messages before pinned ones;
 * 3. the text of an old message, of which only its length is then stated;
 * 4. the structure of an old call, written as a single line instead;
 * 5. old messages in which no call was made;
 * 6. the separate entries of neighbouring old messages that hold only calls.
 *
 * The estimate is checked here, whichever provider is asked, because a
 * provider may cut a state that is too long without saying so. A
 * conversation still over the budget on the last rung is refused by
 * throwing.
 *
 * @param messages the conversation
 * @param calls its paired calls, as `pairCalls` answered them
 * @param need the budget, the pinning and the goal
 * @returns the fitted state, its estimated size and the stage reached
 */
export function stateWithin(
  messages: readonly SessionMessage[],
  calls: readonly Call[],
  need: FitNeed,
): Fitted {
  const frame = (conversation: Entry[]): State => ({
    context: CONTEXT,
    goal: need.goal,
    conversation,
  })
  const frameTokens = estimatedTokensOf(JSON.stringify(frame([])))
  const inputs = new Map(calls.map(call => [call, inputJsonOf(call)]))
  const made = new Map<number, Call[]>()

  for (const call of calls) {
    made.set(call.callIndex, [...(made.get(call.callIndex) ?? []), call])
  }

  let slots: Slot[] = []
  let total = 0

  const tally = () => {
    total = frameTokens

    for (const slot of slots) {
      total += slot.tokens
    }
  }

  const lay = (inputCap: number) => {
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
          result: `${statusOf(call)}, ${call.resultChars} characters, not shown`,
        }))
      }

      slots.push({
        entry,
        tokens: weigh(entry),
        isOld: !isPinnedIndex(at, messages.length, need.preserveRecentMessages),
        isOut: false,
      })
    })

    tally()
  }

  const fits = () => total <= need.maxStateTokens

  const fitted = (stage: Stage): Fitted => {
    const state = frame(
      slots.filter(slot => !slot.isOut).map(slot => slot.entry),
    )

    return { state, tokens: estimatedTokensOf(JSON.stringify(state)), stage }
  }

  for (const cap of INPUT_CAPS) {
    lay(cap)

    if (fits()) {
      return fitted(cap === INPUT_CAPS[0] ? 'whole' : 'inputs shortened')
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

      const now = slot.isOut ? 0 : weigh(slot.entry)

      total += now - slot.tokens
      slot.tokens = now

      if (fits()) {
        return fitted(pass.stage)
      }
    }
  }

  slots = folded(slots.filter(slot => !slot.isOut))
  tally()

  if (fits()) {
    return fitted('rows of old calls joined')
  }

  throw new Error(
    `the conversation does not fit the state budget: about ${total} tokens ` +
      `are left after every reduction and ${need.maxStateTokens} are allowed`,
  )
}
