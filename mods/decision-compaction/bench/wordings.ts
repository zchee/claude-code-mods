import type { QuestionWording } from '../hooks/compact'

/**
 * One way of asking whether a call and its output should stay: the two
 * questions asked about each tool call and the context the state frames
 * them with.
 */
export type Wording = {
  name: string
  /** One line on what it is, or what it changes from the wording before it. */
  note: string
  /** The state's context preamble. */
  context: string
  /** The two questions for one call. */
  callQuestion: QuestionWording['callQuestion']
  resultQuestion: QuestionWording['resultQuestion']
}

/**
 * The context the mod framed every state with until 2026-11-03.
 */
const LEGACY_CONTEXT =
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
 * The context the mod frames every state with, copied so the other wordings
 * can be read against it; a test holds it equal to what the mod sends. It
 * is `LEGACY_CONTEXT` without the sentence that tells the model any tool can
 * be run again, which invites a "no" for every file read, and with the goal
 * tied to the newest prompt, which is what decides the next step.
 */
const CURRENT_CONTEXT =
  'This is the transcript of a coding assistant session whose context ' +
  'window is nearly full. To free space, old tool calls and their outputs ' +
  'are being removed; nothing is summarised or reworded. `conversation` ' +
  'lists the messages in order, oldest first. A tool call appears under ' +
  '`calls` with its `id` and its input. Its output is not shown: `result` ' +
  'only says whether it succeeded and how long it was. Long texts may be ' +
  'shortened and old messages may be missing. `goal` says what the ' +
  'assistant is working on, and what the assistant will do next depends on ' +
  'the newest prompt in it. Each question is about one tool call, named by ' +
  'its `id`.'

const legacyCallQuestion = (named: string) =>
  `Does the assistant still need to know that it made ${named}, and ` +
  'with which input, to carry on with the goal?'

const legacyResultQuestion = (
  named: string,
  outcome: string,
  resultChars: number,
) =>
  `Does the complete output of ${named}, ${outcome}` +
  `${resultChars} characters long, have to stay word for word ` +
  'because the assistant still relies on its content and running the ' +
  'tool again would not bring it back?'

/**
 * Asks whether the fact of the call is needed, rather than whether the
 * assistant "still" needs to know it made the call.
 */
const needCallQuestion = (named: string) =>
  `Will the assistant need the fact that it ran ${named}, and with which ` +
  'input, to carry on with the goal?'

/**
 * Asks whether the exact output is needed for the next step, without
 * "word for word" or the claim that running the tool again would not bring
 * it back.
 */
const exactResultQuestion = (
  named: string,
  outcome: string,
  resultChars: number,
) =>
  `Will the assistant need the exact output of ${named}, ${outcome}` +
  `${resultChars} characters long, for the next step of the goal, rather ` +
  'than a summary or a fresh run?'

/**
 * Every wording, `current` first. `current` is the mod's wording as it is;
 * `legacy` is the one it replaced, and each wording after `legacy` changes
 * one more part of it, the last of those steps being `current`. The
 * wordings after `legacy` were written down before any of them was run, so
 * that the choice between them was made by the benchmark's figures and not
 * by reading its answers.
 */
export const WORDINGS: readonly Wording[] = [
  {
    name: 'current',
    note: 'the questions and context the mod sends today',
    context: CURRENT_CONTEXT,
    callQuestion: needCallQuestion,
    resultQuestion: exactResultQuestion,
  },
  {
    name: 'legacy',
    note: "the mod's wording until 2026-11-03: dropped nearly every call",
    context: LEGACY_CONTEXT,
    callQuestion: legacyCallQuestion,
    resultQuestion: legacyResultQuestion,
  },
  {
    name: 'call-need',
    note: 'the call question asks whether the fact of the call is needed',
    context: LEGACY_CONTEXT,
    callQuestion: needCallQuestion,
    resultQuestion: legacyResultQuestion,
  },
  {
    name: 'result-exact',
    note:
      'as call-need, and the result question asks whether the exact output ' +
      'is needed for the next step',
    context: LEGACY_CONTEXT,
    callQuestion: needCallQuestion,
    resultQuestion: exactResultQuestion,
  },
]

/**
 * The wording of this name.
 *
 * @param name one of the `WORDINGS` names
 * @returns the wording, or undefined for a name that is none of them
 */
export function wordingOf(name: string): Wording | undefined {
  return WORDINGS.find(wording => wording.name === name)
}
