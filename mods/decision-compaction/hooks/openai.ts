import { idsOf, isRecord } from './systemone'
import type { Question, Questions, Wire } from './systemone'

/**
 * One question as OpenAI's Decisions API takes it: a list entry that names
 * itself, where System One keys a map by the id.
 */
type OpenAIQuestion =
  | { name: string; type: 'predicate'; instructions: string }
  | {
      name: string
      type: 'choice'
      instructions: string
      choices: { value: string; description?: string }[]
    }

/**
 * The longest JSON of a value OpenAI sent that an error quotes.
 */
const QUOTED_CHARS = 64

/**
 * A value OpenAI sent, made fit to quote in an error: its JSON, which
 * escapes every control character, when that is short, and only its length
 * otherwise. It is never cut: the message is redacted where it is shown,
 * and a credential cut short would no longer be found there.
 */
function quoted(value: unknown): string {
  const json = JSON.stringify(value)

  if (json === undefined) {
    return 'missing'
  }

  return json.length <= QUOTED_CHARS
    ? json
    : `a value of ${json.length} characters`
}

/**
 * A text made to end a sentence, so that two of them read as two sentences
 * once appended to the instructions.
 */
function sentenceOf(text: string): string {
  const trimmed = text.trim()

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * A question in OpenAI's form. A `predicate` has no field for what yes and
 * no stand for, so a `noul` question's criteria are appended to its
 * instructions, one sentence each; a `choice` option's description is
 * omitted where System One gives `null`.
 */
function questionOf(name: string, question: Question): OpenAIQuestion {
  if (question.type === 'choice') {
    return {
      name,
      type: 'choice',
      instructions: question.instructions,
      choices: Object.entries(question.criteria).map(([value, description]) =>
        description === null ? { value } : { value, description },
      ),
    }
  }

  const said = [question.instructions]
  const criteria = question.criteria ?? {}

  if (criteria.true !== undefined) {
    said.push(`True means: ${sentenceOf(criteria.true)}`)
  }

  if (criteria.false !== undefined) {
    said.push(`False means: ${sentenceOf(criteria.false)}`)
  }

  return { name, type: 'predicate', instructions: said.join(' ') }
}

/**
 * Serialises one request for OpenAI: the state as a JSON string in `input`,
 * which takes text and no object, and the questions as a list.
 *
 * @param model the model name
 * @param state what every question is asked about
 * @param questions the questions, by id
 * @returns the JSON text of the request body
 */
function encodeOpenAI(
  model: string,
  state: unknown,
  questions: Questions,
): string {
  return JSON.stringify({
    model,
    input: JSON.stringify(state),
    questions: idsOf(questions).map(id =>
      questionOf(id, questions[id] as Question),
    ),
  })
}

/**
 * Reads OpenAI's list of answers as the System One map by id, which is what
 * the readers of a reply take: a `predicate`'s probability as `noul`, a
 * `choice`'s pick and confidence as they are. Only the fields read here are
 * relied on, so a field OpenAI adds changes nothing; one it renames throws,
 * naming the field. A refusal to answer throws, naming the question: every
 * question was sent with a name, so every answer has one.
 *
 * An answer is taken only under the name of a question that was asked, and
 * only once: any other name answers nothing the request asked, and a second
 * answer to the same question would leave which one counts to chance. The
 * map has no prototype, so a name such as `__proto__` is an ordinary key.
 *
 * @param payload the decoded response body
 * @param asked the questions the request asked, by id
 * @returns the body in the System One shape
 */
export function decodeOpenAI(payload: unknown, asked: Questions): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.answers)) {
    throw new Error('the response holds no answers list')
  }

  const answers: Record<string, unknown> = Object.create(null)

  payload.answers.forEach((answer: unknown, index) => {
    const at = `answers[${index}]`

    if (!isRecord(answer)) {
      throw new Error(`${at} is not an object`)
    }

    if (typeof answer.name !== 'string' || answer.name === '') {
      throw new Error(`${at}.name is missing`)
    }

    if (!Object.hasOwn(asked, answer.name)) {
      throw new Error(
        `${at}.name is ${quoted(answer.name)}, which was not asked`,
      )
    }

    if (Object.hasOwn(answers, answer.name)) {
      throw new Error(`${at} answers ${answer.name} a second time`)
    }

    if (answer.type === 'refusal') {
      throw new Error(`refused to answer ${answer.name}`)
    }

    if (answer.type === 'predicate') {
      answers[answer.name] = { noul: answer.probability }
    } else if (answer.type === 'choice') {
      // An option's value may be a boolean in OpenAI's schema. Read as text
      // it can only match an option that was offered as that same text;
      // any other pick is refused by the reader of the answer.
      answers[answer.name] = {
        choice:
          typeof answer.choice === 'boolean'
            ? String(answer.choice)
            : answer.choice,
        confidence: answer.confidence,
      }
    } else {
      throw new Error(
        `${at}.type is ${quoted(answer.type)}, neither predicate nor choice`,
      )
    }
  })

  const reported = isRecord(payload.usage) ? payload.usage : {}
  const decoded: Record<string, unknown> = {
    answers,
    usage: { input_tokens: reported.input_tokens },
  }

  if (typeof payload.model === 'string') {
    decoded.model = payload.model
  }

  return decoded
}

/**
 * The body OpenAI's Decisions API takes. The state rides as a string, so its
 * JSON is escaped once more and is measured in that form.
 *
 * OpenAI counts far more input tokens per question than its text: 129
 * one-line predicates were counted as 19,139 input tokens, about 148 each,
 * where Codiv counted about 26 each for the same questions.
 */
export const OPENAI: Wire = {
  encode: encodeOpenAI,
  questionJsonOf: (id, question) => JSON.stringify(questionOf(id, question)),
  stateJsonOf: json => JSON.stringify(json).slice(1, -1),
  tokensPerQuestion: 148,
}
