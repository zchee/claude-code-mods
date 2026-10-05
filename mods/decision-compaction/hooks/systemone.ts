/**
 * A yes/no question; the answer is the probability of yes.
 */
export type NoulQuestion = {
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
 * only `input_tokens` and `output_tokens` are common to the three providers.
 */
export type Usage = {
  input_tokens?: number
  output_tokens?: number
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
export type Picked = {
  choice: string
  confidence?: number
}

/**
 * The strictest id rule among the providers (Cloudflare's): letters, digits,
 * `_`, `.` and `-`, 100 characters at most.
 */
const QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Serialises one request. The three providers take the same three fields, so
 * the body is built once here and only the URL and headers differ.
 *
 * An id a provider would reject is refused before anything is sent: a 422 on
 * one id would otherwise cost the whole batch it rides in.
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
  const ids = Object.keys(questions)

  if (ids.length === 0) {
    throw new Error('a System One request needs at least one question')
  }

  for (const id of ids) {
    if (!QUESTION_ID.test(id)) {
      throw new Error(`question id ${JSON.stringify(id)} is not a valid id`)
    }
  }

  return JSON.stringify({ model, state, questions })
}

/**
 * Reads a decoded response body as a reply. Only the `answers` map is
 * required; each answer is checked when it is read, by the reader that knows
 * which type the question had.
 *
 * @param payload the decoded body, already out of any provider envelope
 * @returns the reply
 */
export function replyOf(payload: unknown): Reply {
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw new Error('the response holds no answers object')
  }

  const reported = isRecord(payload.usage) ? payload.usage : {}
  const usage: Usage = {}
  const inputTokens = numberOf(reported.input_tokens)
  const outputTokens = numberOf(reported.output_tokens)
  const cost = numberOf(reported.cost)

  if (inputTokens !== undefined) {
    usage.input_tokens = inputTokens
  }

  if (outputTokens !== undefined) {
    usage.output_tokens = outputTokens
  }

  if (cost !== undefined) {
    usage.cost = cost
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
  const choice = isRecord(answer) ? answer.choice : undefined

  if (typeof choice !== 'string' || !options.includes(choice)) {
    throw new Error(`no offered option was answered for ${id}`)
  }

  const picked: Picked = { choice }
  const confidence = isRecord(answer) ? numberOf(answer.confidence) : undefined

  if (confidence !== undefined) {
    picked.confidence = confidence
  }

  return picked
}
