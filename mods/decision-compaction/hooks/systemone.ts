/**
 * A yes/no question; the answer is the probability of yes.
 */
type NoulQuestion = {
  type: 'noul'
  instructions: string
  criteria?: { true?: string; false?: string }
}

/**
 * A pick of one option; `criteria` maps each option to what it stands for.
 */
export type ChoiceQuestion = {
  type: 'choice'
  instructions: string
  criteria: Record<string, string | null>
}

export type Question = NoulQuestion | ChoiceQuestion

/**
 * The questions of one request, by the id their answers come back under.
 */
export type Questions = Record<string, Question>

/**
 * What a provider reported a request cost. Every field is optional because
 * the eight providers do not report the same fields.
 */
type Usage = {
  input_tokens?: number
  cost?: number
}

/**
 * One response, unwrapped from whatever envelope its provider put around it.
 */
export type Reply = {
  model?: string
  answers: Record<string, unknown>
  usage: Usage
}

/**
 * The picked option of a `choice` answer and how sure the model was.
 */
type Picked = {
  choice: string
  confidence?: number
}

/**
 * The rule every question id must pass before any provider-specific alias
 * is applied: letters, digits, `_`, `.` and `-`, 100 characters at most. A
 * provider with a stricter rule is sent aliases in place of the ids.
 */
const QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/

/**
 * Whether a decoded JSON value is an object, as opposed to an array, `null`
 * or a scalar.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * How one provider's request body is written, and how big what it carries
 * comes out once written: the token estimate is taken of the text that is
 * sent, not of the objects it was written from.
 */
export type Wire = {
  /**
   * Serialises one request.
   */
  encode: (model: string, state: unknown, questions: Questions) => string
  /**
   * The JSON one question takes in the body, its id included.
   */
  questionJsonOf: (id: string, question: Question) => string
  /**
   * The JSON of the state, or of a part of it, as it stands in the body:
   * as it is, or escaped inside a string.
   */
  stateJsonOf: (json: string) => string
  /**
   * The tokens a provider counts for each question beyond its own text.
   */
  tokensPerQuestion: number
}

const UTF8 = new TextEncoder()

/**
 * The size of a text once sent, in UTF-8 bytes: what a cap stated in bytes
 * is held against. A character beyond ASCII takes two to four of them.
 */
export function bytesOf(text: string): number {
  return UTF8.encode(text).length
}

/**
 * Checks the ids of one request. An id a provider would reject is refused
 * before anything is sent: a 422 on one id would otherwise cost the whole
 * batch it rides in.
 *
 * @param questions the questions, by id
 * @returns the ids; throws when there is none or one is not a valid id
 */
export function idsOf(questions: Questions): string[] {
  const ids = Object.keys(questions)

  if (ids.length === 0) {
    throw new Error('a System One request needs at least one question')
  }

  for (const id of ids) {
    if (!QUESTION_ID.test(id)) {
      throw new Error(`question id ${JSON.stringify(id)} is not a valid id`)
    }
  }

  return ids
}

/**
 * Serialises one request in the System One form: the three fields every
 * provider that speaks the protocol as published takes.
 *
 * @param model the model name as the provider's body spells it
 * @param state what every question is asked about
 * @param questions the questions, by id
 * @returns the JSON text of the request body
 */
export function bodyOf(
  model: string,
  state: unknown,
  questions: Questions,
): string {
  idsOf(questions)

  return JSON.stringify({ model, state, questions })
}

/**
 * The System One body: the state as it is and the questions as a map by id.
 */
export const BARE: Wire = {
  encode: bodyOf,
  questionJsonOf: (id, question) => JSON.stringify({ [id]: question }),
  stateJsonOf: json => json,
  tokensPerQuestion: 0,
}

/**
 * Reads a decoded response body as a reply. Only the `answers` map is
 * required; each answer is checked when it is read, by the reader that knows
 * which type the question had.
 *
 * @param payload the decoded body, already out of any provider envelope
 */
export function replyOf(payload: unknown): Reply {
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw new Error('the response holds no answers object')
  }

  const reported = isRecord(payload.usage) ? payload.usage : {}
  const usage: Usage = {}

  for (const field of ['input_tokens', 'cost'] as const) {
    const value = numberOf(reported[field])

    if (value !== undefined) {
      usage[field] = value
    }
  }

  const reply: Reply = { answers: payload.answers, usage }

  if (typeof payload.model === 'string') {
    reply.model = payload.model
  }

  return reply
}

/**
 * Reads the answer to a `noul` question: a probability, so a finite number
 * from 0 to 1. Anything else throws, because a decision taken on a missing or
 * out-of-range value would delete or keep a tool result for no reason.
 *
 * @param reply the reply the answer is in
 * @param id the question's id
 * @returns the probability of yes
 */
export function noulOf(reply: Reply, id: string): number {
  const answer = reply.answers[id]
  const value = isRecord(answer) ? numberOf(answer.noul) : undefined

  if (value === undefined || value < 0 || value > 1) {
    throw new Error(`no probability from 0 to 1 was answered for ${id}`)
  }

  return value
}

/**
 * Reads the answer to a `choice` question. The pick must be one of the
 * options that were offered: a name outside them cannot be acted on.
 *
 * @param reply the reply the answer is in
 * @param id the question's id
 * @param options the option names the question offered
 * @returns the picked option and the confidence, when one was reported
 */
export function choiceOf(
  reply: Reply,
  id: string,
  options: readonly string[],
): Picked {
  const answer = reply.answers[id]

  if (
    !isRecord(answer) ||
    typeof answer.choice !== 'string' ||
    !options.includes(answer.choice)
  ) {
    throw new Error(`no offered option was answered for ${id}`)
  }

  const picked: Picked = { choice: answer.choice }
  const confidence = numberOf(answer.confidence)

  if (confidence !== undefined) {
    picked.confidence = confidence
  }

  return picked
}
