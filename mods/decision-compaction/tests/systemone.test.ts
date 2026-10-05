import { describe, expect, test } from 'claude-code/testing'

import { bodyOf, choiceOf, noulOf, replyOf } from '../hooks/systemone'
import type { Reply } from '../hooks/systemone'

const QUESTION = { type: 'noul', instructions: 'Is it?' } as const

function replyWith(answers: Record<string, unknown>): Reply {
  return { answers, usage: {} }
}

describe('bodyOf', () => {
  test('success: the body holds the model, the state and the questions', () => {
    const body = bodyOf('jev-latest', { a: 1 }, { keep_t1: QUESTION })

    expect(JSON.parse(body)).toEqual({
      model: 'jev-latest',
      state: { a: 1 },
      questions: { keep_t1: { type: 'noul', instructions: 'Is it?' } },
    })
  })

  const refused: Record<string, { id: string; message: string }> = {
    'error: an id with a space is refused': {
      id: 'call t1',
      message: 'question id "call t1" is not a valid id',
    },
    'error: an id with a slash is refused': {
      id: 'call/t1',
      message: 'question id "call/t1" is not a valid id',
    },
    'error: an id of 101 characters is refused': {
      id: 'a'.repeat(101),
      message: 'is not a valid id',
    },
  }

  for (const [name, { id, message }] of Object.entries(refused)) {
    test(name, () => {
      expect(() => bodyOf('m', 's', { [id]: QUESTION })).toThrow(message)
    })
  }

  test('success: an id of 100 allowed characters passes', () => {
    const id = `${'a'.repeat(96)}_.-9`

    expect(
      Object.keys(JSON.parse(bodyOf('m', 's', { [id]: QUESTION })).questions),
    ).toEqual([id])
  })

  test('error: a request with no question is refused', () => {
    expect(() => bodyOf('m', 's', {})).toThrow('needs at least one question')
  })
})

describe('replyOf', () => {
  test('success: answers, model and every reported usage figure are read', () => {
    expect(
      replyOf({
        id: 'gen-1',
        model: 'jev-1.13.0',
        answers: { a: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 476, output_tokens: 70, cost: 0.00002 },
      }),
    ).toEqual({
      model: 'jev-1.13.0',
      answers: { a: { type: 'noul', noul: 0.5 } },
      usage: { input_tokens: 476, output_tokens: 70, cost: 0.00002 },
    })
  })

  test('success: a reply with no usage reads as an empty usage', () => {
    expect(replyOf({ answers: {} })).toEqual({ answers: {}, usage: {} })
  })

  test('success: a usage figure that is not a number is left out', () => {
    expect(
      replyOf({ answers: {}, usage: { input_tokens: '476' } }).usage,
    ).toEqual({})
  })

  const malformed: Record<string, unknown> = {
    'error: a body without answers is refused': { model: 'jev' },
    'error: answers as a list is refused': { answers: [] },
    'error: a null body is refused': null,
    'error: a string body is refused': 'ok',
  }

  for (const [name, payload] of Object.entries(malformed)) {
    test(name, () => {
      expect(() => replyOf(payload)).toThrow(
        'the response holds no answers object',
      )
    })
  }
})

describe('noulOf', () => {
  const read: Record<string, number> = {
    'success: 0 is a probability': 0,
    'success: 1 is a probability': 1,
    'success: 0.37 is a probability': 0.37,
  }

  for (const [name, noul] of Object.entries(read)) {
    test(name, () => {
      expect(noulOf(replyWith({ q: { type: 'noul', noul } }), 'q')).toBe(noul)
    })
  }

  const refused: Record<string, unknown> = {
    'error: a missing answer is refused': undefined,
    'error: an answer above 1 is refused': { type: 'noul', noul: 1.01 },
    'error: a negative answer is refused': { type: 'noul', noul: -0.01 },
    'error: a string answer is refused': { type: 'noul', noul: '0.9' },
    'error: a null answer is refused': { type: 'noul', noul: null },
    'error: a choice answer is refused': { type: 'choice', choice: 'a' },
  }

  for (const [name, answer] of Object.entries(refused)) {
    test(name, () => {
      expect(() => noulOf(replyWith({ q: answer }), 'q')).toThrow(
        'no probability from 0 to 1 was answered for q',
      )
    })
  }
})

describe('choiceOf', () => {
  test('success: an offered option is read with its confidence', () => {
    const reply = replyWith({
      route: {
        type: 'choice',
        choice: 'b',
        probabilities: { a: 0.2, b: 0.8 },
        confidence: 0.6,
      },
    })

    expect(choiceOf(reply, 'route', ['a', 'b'])).toEqual({
      choice: 'b',
      confidence: 0.6,
    })
  })

  test('success: a pick with no confidence reads without one', () => {
    expect(
      choiceOf(replyWith({ route: { choice: 'a' } }), 'route', ['a', 'b']),
    ).toEqual({
      choice: 'a',
    })
  })

  const refused: Record<string, unknown> = {
    'error: an option that was not offered is refused': {
      type: 'choice',
      choice: 'c',
    },
    'error: a missing answer is refused': undefined,
    'error: a noul answer is refused': { type: 'noul', noul: 0.5 },
  }

  for (const [name, answer] of Object.entries(refused)) {
    test(name, () => {
      expect(() =>
        choiceOf(replyWith({ route: answer }), 'route', ['a', 'b']),
      ).toThrow('no offered option was answered for route')
    })
  }
})
