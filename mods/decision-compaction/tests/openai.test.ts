import { describe, expect, test } from 'claude-code/testing'

import { decodeOpenAI, encodeOpenAI, OPENAI } from '../hooks/openai'
import { choiceOf, noulOf, replyOf } from '../hooks/systemone'
import type { Questions } from '../hooks/systemone'

/**
 * OpenAI's answer to the probe's two questions, as it was recorded.
 */
const RECORDED = {
  model: 'gpt-6-luna',
  answers: [
    { type: 'predicate', name: 'asks_weather', probability: 1.0 },
    {
      type: 'choice',
      name: 'topic',
      choice: 'weather',
      probabilities: [
        { value: 'weather', probability: 1.0 },
        { value: 'cooking', probability: 0.0 },
        { value: 'code', probability: 0.0 },
      ],
      confidence: 1.0,
    },
  ],
  usage: {
    input_tokens: 318,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 318,
  },
}

/**
 * The questions the decoded answers were asked as.
 */
const ASKED: Questions = {
  asks_weather: { type: 'noul', instructions: 'Is it about the weather?' },
  topic: {
    type: 'choice',
    instructions: 'Which topic?',
    criteria: { weather: null, cooking: null, code: null },
  },
  q: { type: 'noul', instructions: 'Is it?' },
  a: { type: 'noul', instructions: 'Is it?' },
}

describe('encodeOpenAI', () => {
  test('success: the state rides as JSON text and the questions as a list', () => {
    const questions: Questions = {
      call_t1: { type: 'noul', instructions: 'Is it?' },
      route: {
        type: 'choice',
        instructions: 'Which?',
        criteria: { 'typesafe.jev-latest': 'Jev.', 'cloudflare.clef': null },
      },
    }

    expect(encodeOpenAI('gpt-6-luna', { goal: 'say "hi"' }, questions)).toBe(
      '{"model":"gpt-6-luna","input":"{\\"goal\\":\\"say \\\\\\"hi\\\\\\"\\"}",' +
        '"questions":[' +
        '{"name":"call_t1","type":"predicate","instructions":"Is it?"},' +
        '{"name":"route","type":"choice","instructions":"Which?","choices":' +
        '[{"value":"typesafe.jev-latest","description":"Jev."},' +
        '{"value":"cloudflare.clef"}]}]}',
    )
  })

  const folded: Record<
    string,
    { criteria: { true?: string; false?: string }; instructions: string }
  > = {
    'success: a true and false pair is appended as two sentences': {
      criteria: { true: 'the call is still needed', false: 'it is not.' },
      instructions:
        'Keep it? True means: the call is still needed. ' +
        'False means: it is not.',
    },
    'success: only the criterion given is appended': {
      criteria: { false: 'it can go' },
      instructions: 'Keep it? False means: it can go.',
    },
    'success: no criteria leave the instructions as they are': {
      criteria: {},
      instructions: 'Keep it?',
    },
  }

  for (const [name, { criteria, instructions }] of Object.entries(folded)) {
    test(name, () => {
      const body = JSON.parse(
        encodeOpenAI('m', 's', {
          q: { type: 'noul', instructions: 'Keep it?', criteria },
        }),
      )

      expect(body.questions).toEqual([
        { name: 'q', type: 'predicate', instructions },
      ])
    })
  }

  test('error: an id OpenAI may refuse is refused before anything is sent', () => {
    const questions: Questions = {
      'call t1': { type: 'noul', instructions: 'x' },
    }

    expect(() => encodeOpenAI('m', 's', questions)).toThrow({
      message: 'question id "call t1" is not a valid id',
    })
  })

  test('error: a request without questions is refused', () => {
    expect(() => encodeOpenAI('m', 's', {})).toThrow({
      message: 'a System One request needs at least one question',
    })
  })
})

describe('decodeOpenAI', () => {
  test('success: the recorded answer list reads as the System One map', () => {
    const reply = replyOf(decodeOpenAI(RECORDED, ASKED))

    expect(reply).toEqual({
      model: 'gpt-6-luna',
      answers: {
        asks_weather: { noul: 1 },
        topic: { choice: 'weather', confidence: 1 },
      },
      usage: { input_tokens: 318, output_tokens: 0 },
    })
    expect(noulOf(reply, 'asks_weather')).toBe(1)
    expect(choiceOf(reply, 'topic', ['weather', 'cooking', 'code'])).toEqual({
      choice: 'weather',
      confidence: 1,
    })
  })

  const refused: Record<string, { payload: unknown; message: string }> = {
    'error: an answer of an unknown type is refused, naming the type': {
      payload: {
        answers: [{ type: 'score', name: 'q', score: 3 }],
        usage: {},
      },
      message: 'answers[0].type is "score", neither predicate nor choice',
    },
    'error: an answer without a type is refused, naming the field': {
      payload: { answers: [{ name: 'q', probability: 0.5 }] },
      message: 'answers[0].type is missing, neither predicate nor choice',
    },
    'error: an answer without a name is refused, naming the field': {
      payload: {
        answers: [
          { type: 'predicate', name: 'a', probability: 0.5 },
          { type: 'predicate', probability: 0.5 },
        ],
      },
      message: 'answers[1].name is missing',
    },
    'error: an answer that is no object is refused': {
      payload: { answers: ['yes'] },
      message: 'answers[0] is not an object',
    },
    'error: answers given as a map are refused': {
      payload: { answers: { q: { type: 'noul', noul: 0.5 } } },
      message: 'the response holds no answers list',
    },
    'error: an answer to a question that was not asked is refused, naming it':
      {
        payload: {
          answers: [{ type: 'predicate', name: 'call_t9', probability: 1 }],
        },
        message: 'answers[0].name is "call_t9", which was not asked',
      },
    'error: an answer named __proto__ is refused when no such question was asked':
      {
        payload: JSON.parse(
          '{"answers":[{"type":"predicate","name":"__proto__","probability":1}]}',
        ),
        message: 'answers[0].name is "__proto__", which was not asked',
      },
    'error: a name that is in no question but on every object is refused': {
      payload: {
        answers: [{ type: 'predicate', name: 'constructor', probability: 1 }],
      },
      message: 'answers[0].name is "constructor", which was not asked',
    },
    'error: a second answer to the same question is refused': {
      payload: {
        answers: [
          { type: 'predicate', name: 'q', probability: 0.1 },
          { type: 'predicate', name: 'a', probability: 0.5 },
          { type: 'predicate', name: 'q', probability: 0.9 },
        ],
      },
      message: 'answers[2] answers q a second time',
    },
    'error: a long name that was not asked is named by its length, not quoted':
      {
        payload: {
          answers: [
            { type: 'predicate', name: `x\n\u001b[31m${'y'.repeat(5000)}` },
          ],
        },
        message:
          'answers[0].name is a value of 5015 characters, which was not ' +
          'asked',
      },
    'error: a long type is named by its length, not quoted': {
      payload: { answers: [{ type: 'z'.repeat(100), name: 'q' }] },
      message:
        'answers[0].type is a value of 102 characters, neither predicate ' +
        'nor choice',
    },
    'error: a refusal names the question it refused': {
      payload: { answers: [{ type: 'refusal', name: 'q', refusal: 'no' }] },
      message: 'refused to answer q',
    },
  }

  for (const [name, { payload, message }] of Object.entries(refused)) {
    test(name, () => {
      expect(() => decodeOpenAI(payload, ASKED)).toThrow({ message })
    })
  }

  test('success: a question asked as __proto__ is answered as an ordinary key', () => {
    const asked: Questions = JSON.parse(
      '{"__proto__":{"type":"noul","instructions":"Is it?"}}',
    )
    const decoded = decodeOpenAI(
      JSON.parse(
        '{"answers":[{"type":"predicate","name":"__proto__","probability":0.4}]}',
      ),
      asked,
    )
    const reply = replyOf(decoded)

    expect(Object.hasOwn(reply.answers, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(reply.answers)).toBe(null)
    expect(noulOf(reply, '__proto__')).toBe(0.4)
    expect(Object.prototype.hasOwnProperty.call({}, 'noul')).toBe(false)
  })

  test('error: a probability out of range is left for the reader to refuse', () => {
    const reply = replyOf(
      decodeOpenAI(
        {
          answers: [{ type: 'predicate', name: 'q', probability: 1.5 }],
        },
        ASKED,
      ),
    )

    expect(() => noulOf(reply, 'q')).toThrow({
      message: 'no probability from 0 to 1 was answered for q',
    })
  })
})

describe('the OpenAI wire format', () => {
  test("success: a question is measured in OpenAI's own form", () => {
    expect(
      OPENAI.questionJsonOf('route', {
        type: 'choice',
        instructions: 'Which?',
        criteria: { a: null },
      }),
    ).toBe(
      '{"name":"route","type":"choice","instructions":"Which?",' +
        '"choices":[{"value":"a"}]}',
    )
  })

  test('success: the state is measured as it stands escaped inside input', () => {
    const state = { text: 'say "hi"' }
    const body = JSON.parse(
      encodeOpenAI('m', state, { q: { type: 'noul', instructions: 'x' } }),
    )
    const carried = OPENAI.stateJsonOf(JSON.stringify(state))

    expect(carried).toBe('{\\"text\\":\\"say \\\\\\"hi\\\\\\"\\"}')
    expect(JSON.stringify(body.input)).toBe(`"${carried}"`)
  })
})
