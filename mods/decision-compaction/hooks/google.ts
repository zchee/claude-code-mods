import { aliasedOf, aliasOf, isRecord, quoted } from './systemone'
import type { Question, Questions, Wire } from './systemone'

/**
 * How many questions one request to Google's Decisions API may hold: "1 to
 * 1,000 questions".
 */
export const GOOGLE_QUESTIONS = 1_000

/**
 * One question as Google's Decisions API takes it. A `noul` question names
 * what yes and no stand for `true_description` and `false_description`,
 * and a `choice` option always has a description, an empty one "when the
 * option ID is self-explanatory".
 */
type GoogleQuestion =
  | {
      type: 'noul'
      instructions: string
      criteria?: { true_description?: string; false_description?: string }
    }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }

/**
 * The longest alias a request can carry: the one of the last place the
 * question cap allows. A question is measured under it, whatever its own
 * id, since an alias is what is sent.
 */
const LONGEST_ALIAS = aliasOf(GOOGLE_QUESTIONS - 1)

/**
 * A question in Google's form. Only the criteria differ from System One's:
 * the two of a `noul` question are renamed, and a `choice` option System
 * One gives `null` gets the empty description, the form Google documents
 * (it also took `null` on 2026-11-25).
 */
function questionOf(question: Question): GoogleQuestion {
  if (question.type === 'choice') {
    return {
      type: 'choice',
      instructions: question.instructions,
      criteria: Object.fromEntries(
        Object.entries(question.criteria).map(([option, description]) => [
          option,
          description ?? '',
        ]),
      ),
    }
  }

  const asked: GoogleQuestion = {
    type: 'noul',
    instructions: question.instructions,
  }
  const { true: yes, false: no } = question.criteria ?? {}

  if (yes !== undefined || no !== undefined) {
    asked.criteria = {
      ...(yes === undefined ? {} : { true_description: yes }),
      ...(no === undefined ? {} : { false_description: no }),
    }
  }

  return asked
}

/**
 * Serialises one request for Google: the state as a JSON string in `input`,
 * which takes text or content blocks and no object of the caller's, and
 * the questions as a map by their place. Google takes a question key of
 * letters, digits, `_` and `-`, 64 characters at most; the mod's ids may
 * hold `.` and run to 100 characters.
 *
 * @param model the model name
 * @param state what every question is asked about
 * @param questions the questions, by id
 * @returns the JSON text of the request body
 */
function encodeGoogle(
  model: string,
  state: unknown,
  questions: Questions,
): string {
  return JSON.stringify({
    model,
    input: JSON.stringify(state),
    questions: Object.fromEntries(
      Object.entries(aliasedOf(questions)).map(([alias, question]) => [
        alias,
        questionOf(question),
      ]),
    ),
  })
}

/**
 * A field of Google's `prompt_feedback` as a sentence can hold it: its text
 * when it is one that says something.
 */
function saidOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined
}

/**
 * Reads Google's response as the System One reply the readers of a reply
 * take. Its answers already have that shape (`noul`, or `choice` and
 * `confidence`) and stay under the places the questions were sent by, in
 * no order to rely on (on 2026-11-25 they came back in the reverse of the
 * request's); its count of input tokens is `usage.total_input_tokens`. It
 * names no model and no cost.
 *
 * A response whose `prompt_feedback.block_reason` is set evaluated no
 * question and holds no answer, so it throws with the reason given. Each
 * answer names its type, and one whose type is not that of the question
 * asked in its place is refused, naming the question: a `score` read as a
 * probability would decide on a number that is none. An answer that names
 * no type is left to the reader of its question, which checks its value.
 *
 * @param payload the decoded response body
 * @param asked the questions the request asked, by id, in the order sent
 * @returns the body in the System One shape, answers still by place
 */
export function decodeGoogle(
  payload: unknown,
  asked: Questions,
): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new Error('the response is not an object')
  }

  const feedback = isRecord(payload.prompt_feedback)
    ? payload.prompt_feedback
    : {}

  if (feedback.block_reason !== undefined && feedback.block_reason !== null) {
    const said = [
      saidOf(feedback.block_reason),
      saidOf(feedback.block_reason_message),
    ].filter(part => part !== undefined)

    throw new Error(
      `the input was blocked${said.length > 0 ? `: ${said.join(': ')}` : ''}`,
    )
  }

  if (isRecord(payload.answers)) {
    const idOf = new Map(Object.keys(asked).map((id, at) => [aliasOf(at), id]))

    for (const [alias, answer] of Object.entries(payload.answers)) {
      const id = idOf.get(alias)
      const question = id === undefined ? undefined : asked[id]

      if (
        question !== undefined &&
        isRecord(answer) &&
        answer.type !== undefined &&
        answer.type !== question.type
      ) {
        throw new Error(
          `the answer to ${id} is of type ${quoted(answer.type)}, ` +
            `not ${question.type}`,
        )
      }
    }
  }

  const reported = isRecord(payload.usage) ? payload.usage : {}

  return {
    answers: payload.answers,
    usage: { input_tokens: reported.total_input_tokens },
  }
}

/**
 * The body Google's Decisions API takes. The state rides as a string, so
 * its JSON is escaped once more and is measured in that form.
 *
 * Google counts more input tokens per question than the text the mod
 * estimates: on 2026-11-25 one state with 1, 2, 8 and 32 of the mod's
 * questions was counted as 1,115, 1,193, 1,632 and 3,406 input tokens,
 * about 74 a question, where the mod estimates the same questions at about
 * 59. The state was counted once a request.
 */
export const GOOGLE: Wire = {
  encode: encodeGoogle,
  questionJsonOf: (_id, question) =>
    JSON.stringify({ [LONGEST_ALIAS]: questionOf(question) }),
  stateJsonOf: json => JSON.stringify(json).slice(1, -1),
  tokensPerQuestion: 15,
}
