import { describe, expect, test } from 'claude-code/testing'

import { WORDINGS, wordingOf } from '../bench/wordings'
import type { Wording } from '../bench/wordings'
import { questionsOf, questionsWith } from '../hooks/compact'
import { pairCalls, stateWithin } from '../hooks/state'
import { BARE } from '../hooks/systemone'
import { callOf, sessionOf } from './fixtures'

/**
 * The context the mod frames a state with today, read from a state it
 * fits rather than from a copy.
 */
function modContext(context?: string): string {
  const messages = sessionOf()

  return stateWithin(messages, pairCalls(messages, 2), {
    maxStateTokens: 25_000,
    preserveRecentMessages: 2,
    goal: 'fix the test',
    wire: BARE,
    ...(context === undefined ? {} : { context }),
  }).state.context
}

/**
 * Every string a wording produces for one call that failed and one that
 * did not, with its context.
 */
function stringsOf(wording: Wording): string[] {
  return [
    wording.context,
    wording.callQuestion('tool call t1 (Read)'),
    wording.resultQuestion('tool call t1 (Read)', '', 1000),
    wording.resultQuestion('tool call t2 (Bash)', 'an error, ', 42),
  ]
}

describe('wordings', () => {
  test('success: current is the first wording', () => {
    expect(WORDINGS[0]?.name).toBe('current')
    expect(WORDINGS.map(wording => wording.name)).toEqual([
      'current',
      'legacy',
      'call-need',
      'result-exact',
    ])
  })

  test("success: current asks exactly the mod's questions", () => {
    const current = wordingOf('current') as Wording
    const calls = [
      callOf(1),
      callOf(2, { tool: 'Bash', isError: true, resultChars: 42 }),
      callOf(3, { tool: 'mcp__server__tool', resultChars: 0 }),
    ]

    for (const call of calls) {
      expect(questionsWith(call, current)).toEqual(questionsOf(call))
    }
  })

  test("success: current frames the state with exactly the mod's context", () => {
    expect((wordingOf('current') as Wording).context).toBe(modContext())
  })

  test('success: a context given to the fitting is the one the state carries', () => {
    for (const wording of WORDINGS) {
      expect(modContext(wording.context)).toBe(wording.context)
    }
  })

  test('success: each step from legacy to current changes only what its note says', () => {
    const [current, legacy, callNeed, resultExact] = WORDINGS.map(
      stringsOf,
    ) as [string[], string[], string[], string[]]
    const changed = (from: string[], to: string[]) =>
      from.flatMap((text, index) => (text === to[index] ? [] : [index]))

    // 0 is the context, 1 the call question, 2 and 3 the result question.
    expect(changed(legacy, callNeed)).toEqual([1])
    expect(changed(callNeed, resultExact)).toEqual([2, 3])
    expect(changed(resultExact, current)).toEqual([0])
  })

  test('success: every wording has non-empty strings, distinct from each other', () => {
    for (const wording of WORDINGS) {
      const strings = [wording.name, wording.note, ...stringsOf(wording)]

      for (const text of strings) {
        expect(text.trim(), `${wording.name}: an empty string`).not.toBe('')
      }

      expect(new Set(strings).size, `${wording.name}: a repeated string`).toBe(
        strings.length,
      )
    }

    const names = WORDINGS.map(wording => wording.name)
    const notes = WORDINGS.map(wording => wording.note)

    expect(new Set(names).size).toBe(names.length)
    expect(new Set(notes).size).toBe(notes.length)
  })

  test('success: every question names its call, its outcome and its length', () => {
    for (const wording of WORDINGS) {
      expect(wording.callQuestion('tool call t1 (Read)')).toContain(
        'tool call t1 (Read)',
      )
      expect(
        wording.resultQuestion('tool call t2 (Bash)', 'an error, ', 42),
      ).toContain('tool call t2 (Bash), an error, 42 characters long')
      expect(wording.resultQuestion('tool call t1 (Read)', '', 7)).toContain(
        'tool call t1 (Read), 7 characters long',
      )
    }
  })

  test('success: the wordings say what they were written to say', () => {
    expect(
      (wordingOf('current') as Wording).callQuestion('tool call t1 (Read)'),
    ).toBe(
      'Will the assistant need the fact that it ran tool call t1 (Read), ' +
        'and with which input, to carry on with the goal?',
    )
    expect(
      (wordingOf('current') as Wording).resultQuestion(
        'tool call t1 (Read)',
        '',
        1000,
      ),
    ).toBe(
      'Will the assistant need the exact output of tool call t1 (Read), ' +
        '1000 characters long, for the next step of the goal, rather than ' +
        'a summary or a fresh run?',
    )

    const { context } = wordingOf('current') as Wording

    expect(context).not.toContain('can run any tool again')
    expect(context).toContain(
      '`goal` says what the assistant is working on, and what the ' +
        'assistant will do next depends on the newest prompt in it.',
    )
    expect(context.match(/`goal` says/g)).toHaveLength(1)

    const legacy = wordingOf('legacy') as Wording

    expect(legacy.callQuestion('tool call t1 (Read)')).toBe(
      'Does the assistant still need to know that it made tool call t1 ' +
        '(Read), and with which input, to carry on with the goal?',
    )
    expect(legacy.resultQuestion('tool call t1 (Read)', '', 1000)).toBe(
      'Does the complete output of tool call t1 (Read), 1000 characters ' +
        'long, have to stay word for word because the assistant still ' +
        'relies on its content and running the tool again would not bring ' +
        'it back?',
    )
    expect(legacy.context).toEndWith(
      'What is removed is gone for good, but the assistant can run any ' +
        'tool again and read any file again.',
    )
  })

  test('error: a name that is no wording has none', () => {
    expect(wordingOf('no-such-wording')).toBeUndefined()
    expect(wordingOf('')).toBeUndefined()
    expect(wordingOf('Current')).toBeUndefined()
  })
})
