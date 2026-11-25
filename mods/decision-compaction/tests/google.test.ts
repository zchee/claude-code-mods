import { describe, expect, test } from 'claude-code/testing'

import { decodeGoogle, GOOGLE, GOOGLE_QUESTIONS } from '../hooks/google'
import { aliasOf, choiceOf, noulOf, replyOf } from '../hooks/systemone'
import type { Question, Questions } from '../hooks/systemone'

/**
 * The questions the answers below were asked as, in the order sent: the
 * first goes out as `q0`, the second as `q1`.
 */
const KEEP: Question = {
  type: 'noul',
  instructions: 'Is the call still needed?',
}
const ROUTE: Question = {
  type: 'choice',
  instructions: 'Which model?',
  criteria: { 'typesafe.jev-latest': 'Jev.', 'google.gemini-decision-1': null },
}
const ASKED: Questions = { 'call_t1.keep': KEEP, route: ROUTE }

/**
 * Google's answer to `ASKED` in the shape its API reference documents for
 * a `noul` and a `choice` answer, and the usage its guide shows.
 */
const DOCUMENTED = {
  answers: {
    q0: { type: 'noul', noul: 0.97, confidence: 0.97 },
    q1: {
      type: 'choice',
      choice: 'google.gemini-decision-1',
      confidence: 0.95,
      probabilities: {
        'google.gemini-decision-1': 0.95,
        'typesafe.jev-latest': 0.05,
      },
    },
  },
  usage: {
    total_input_tokens: 152,
    input_tokens_by_modality: [{ modality: 'text', tokens: 152 }],
    total_output_tokens: 0,
    total_tokens: 152,
  },
}

describe('encodeGoogle', () => {
  test('success: the state rides as JSON text and each question by its place, in Google criteria', () => {
    const questions: Questions = {
      'call_t1.keep': {
        type: 'noul',
        instructions: 'Keep it?',
        criteria: { true: 'still needed', false: 'not needed' },
      },
      route: {
        type: 'choice',
        instructions: 'Which?',
        criteria: { 'typesafe.jev-latest': 'Jev.', 'cloudflare.clef': null },
      },
    }

    expect(
      GOOGLE.encode('gemini-decision-1', { goal: 'say "hi"' }, questions),
    ).toBe(
      '{"model":"gemini-decision-1",' +
        '"input":"{\\"goal\\":\\"say \\\\\\"hi\\\\\\"\\"}",' +
        '"questions":{' +
        '"q0":{"type":"noul","instructions":"Keep it?","criteria":' +
        '{"true_description":"still needed","false_description":"not needed"}},' +
        '"q1":{"type":"choice","instructions":"Which?","criteria":' +
        '{"typesafe.jev-latest":"Jev.","cloudflare.clef":""}}}}',
    )
  })

  const criteria: Record<
    string,
    { given?: { true?: string; false?: string }; sent?: object }
  > = {
    'success: a noul question without criteria is sent without any': {},
    'success: empty criteria are sent as none': { given: {} },
    'success: only the criterion given is sent, renamed': {
      given: { false: 'it can go' },
      sent: { false_description: 'it can go' },
    },
    'success: a true criterion alone is sent as true_description': {
      given: { true: 'it stays' },
      sent: { true_description: 'it stays' },
    },
  }

  for (const [name, { given, sent }] of Object.entries(criteria)) {
    test(name, () => {
      const body = JSON.parse(
        GOOGLE.encode('m', 's', {
          q: {
            type: 'noul',
            instructions: 'Keep it?',
            ...(given === undefined ? {} : { criteria: given }),
          },
        }),
      )

      expect(body.questions).toEqual({
        q0: {
          type: 'noul',
          instructions: 'Keep it?',
          ...(sent === undefined ? {} : { criteria: sent }),
        },
      })
    })
  }

  test('success: an id Google would refuse, dotted and 100 characters long, goes out as its place', () => {
    const long = `call_${'x'.repeat(95)}`
    const body = JSON.parse(
      GOOGLE.encode('m', 's', {
        'call_t1.keep': { type: 'noul', instructions: 'a' },
        [long]: { type: 'noul', instructions: 'b' },
      }),
    )

    expect(Object.keys(body.questions)).toEqual(['q0', 'q1'])
    expect(body.questions.q1.instructions).toBe('b')
  })

  test('success: a state that is a string is sent as its JSON, so it reads back as the same value', () => {
    const body = JSON.parse(GOOGLE.encode('m', 'plain text', { q: ROUTE }))

    expect(body.input).toBe('"plain text"')
    expect(JSON.parse(body.input)).toBe('plain text')
    expect('state' in body).toBe(false)
  })

  test('error: an id the mod itself refuses is refused before anything is sent', () => {
    expect(() =>
      GOOGLE.encode('m', 's', { 'call t1': { type: 'noul', instructions: 'x' } }),
    ).toThrow({ message: 'question id "call t1" is not a valid id' })
  })

  test('error: a request without questions is refused', () => {
    expect(() => GOOGLE.encode('m', 's', {})).toThrow({
      message: 'a System One request needs at least one question',
    })
  })
})

describe('decodeGoogle', () => {
  test('success: the documented answers read as the System One reply, still by place', () => {
    const reply = replyOf(decodeGoogle(DOCUMENTED, ASKED))

    expect(reply).toEqual({
      answers: DOCUMENTED.answers,
      usage: { input_tokens: 152 },
    })
    expect('model' in reply).toBe(false)
    expect(noulOf(reply, 'q0')).toBe(0.97)
    expect(
      choiceOf(reply, 'q1', ['typesafe.jev-latest', 'google.gemini-decision-1']),
    ).toEqual({ choice: 'google.gemini-decision-1', confidence: 0.95 })
  })

  test('success: answers in the reverse of the order asked, as Google answered on 2026-11-25, read the same', () => {
    const measured = {
      answers: {
        q1: {
          type: 'choice',
          choice: 'typesafe.jev-latest',
          probabilities: {
            'google.gemini-decision-1': 0.2,
            'typesafe.jev-latest': 0.8,
          },
          confidence: 0.8,
        },
        q0: { type: 'noul', noul: 0.12, confidence: 0.88 },
      },
      usage: {
        total_tokens: 1193,
        total_input_tokens: 1193,
        input_tokens_by_modality: [{ modality: 'text', tokens: 1193 }],
        total_output_tokens: 0,
      },
    }
    const reply = replyOf(decodeGoogle(measured, ASKED))

    expect(reply.usage).toEqual({ input_tokens: 1193 })
    expect(noulOf(reply, 'q0')).toBe(0.12)
    expect(
      choiceOf(reply, 'q1', ['typesafe.jev-latest', 'google.gemini-decision-1']),
    ).toEqual({ choice: 'typesafe.jev-latest', confidence: 0.8 })
  })

  test('success: a choice answer without usage, as the reference shows one, has no count', () => {
    const reply = replyOf(
      decodeGoogle({ answers: { q1: DOCUMENTED.answers.q1 } }, ASKED),
    )

    expect(reply.usage).toEqual({})
  })

  test('success: an answer that names no type is left to the reader of its question', () => {
    const reply = replyOf(decodeGoogle({ answers: { q0: { noul: 0.4 } } }, ASKED))

    expect(noulOf(reply, 'q0')).toBe(0.4)
  })

  test('success: an answer under a place that was not asked is left for the caller to refuse', () => {
    expect(decodeGoogle({ answers: { q9: { type: 'score' } } }, ASKED)).toEqual({
      answers: { q9: { type: 'score' } },
      usage: { input_tokens: undefined },
    })
  })

  const refused: Record<string, { payload: unknown; message: string }> = {
    'error: a blocked input names the reason and its message': {
      payload: {
        answers: {},
        prompt_feedback: {
          block_reason: 'safety',
          block_reason_message: 'Blocked for harmful content.',
        },
      },
      message: 'the input was blocked: safety: Blocked for harmful content.',
    },
    'error: a blocked input without a message names the reason alone': {
      payload: { prompt_feedback: { block_reason: 'prohibited_content' } },
      message: 'the input was blocked: prohibited_content',
    },
    'error: a block reason that says nothing is still a block': {
      payload: { answers: {}, prompt_feedback: { block_reason: '  ' } },
      message: 'the input was blocked',
    },
    'error: a block wins over answers that came with it': {
      payload: {
        answers: DOCUMENTED.answers,
        prompt_feedback: { block_reason: 'other' },
      },
      message: 'the input was blocked: other',
    },
    'error: a noul question answered as a score is refused, naming the question': {
      payload: { answers: { q0: { type: 'score', score: 1.8 } } },
      message: 'the answer to call_t1.keep is of type "score", not noul',
    },
    'error: a choice question answered as a noul is refused, naming the question': {
      payload: { answers: { q1: { type: 'noul', noul: 0.9 } } },
      message: 'the answer to route is of type "noul", not choice',
    },
    'error: a type that is not text is quoted as its JSON': {
      payload: { answers: { q0: { type: null, noul: 0.9 } } },
      message: 'the answer to call_t1.keep is of type null, not noul',
    },
    'error: a long type is named only by its length': {
      payload: { answers: { q0: { type: 'x'.repeat(100), noul: 0.9 } } },
      message:
        'the answer to call_t1.keep is of type a value of 102 characters, not noul',
    },
    'error: a body that is not an object is refused': {
      payload: [DOCUMENTED],
      message: 'the response is not an object',
    },
  }

  for (const [name, { payload, message }] of Object.entries(refused)) {
    test(name, () => {
      expect(() => decodeGoogle(payload, ASKED)).toThrow({ message })
    })
  }

  test('success: a feedback without a block reason is no block', () => {
    const reply = replyOf(
      decodeGoogle(
        { ...DOCUMENTED, prompt_feedback: { block_reason: null } },
        ASKED,
      ),
    )

    expect(noulOf(reply, 'q0')).toBe(0.97)
  })

  test('error: a body without answers holds no answers object', () => {
    expect(() => replyOf(decodeGoogle({ usage: DOCUMENTED.usage }, ASKED))).toThrow({
      message: 'the response holds no answers object',
    })
  })

  test('error: an empty answers map leaves every question unanswered', () => {
    const reply = replyOf(decodeGoogle({ answers: {} }, ASKED))

    expect(() => noulOf(reply, 'q0')).toThrow({
      message: 'no probability from 0 to 1 was answered for q0',
    })
  })
})

describe('the Google wire format', () => {
  test("success: a question is measured in Google's own form under the longest place", () => {
    expect(GOOGLE.questionJsonOf('anything', KEEP)).toBe(
      JSON.stringify({
        [aliasOf(GOOGLE_QUESTIONS - 1)]: {
          type: 'noul',
          instructions: 'Is the call still needed?',
        },
      }),
    )
    expect(aliasOf(GOOGLE_QUESTIONS - 1)).toBe('q999')
  })

  test('success: a null option is measured as the empty description it is sent as', () => {
    expect(GOOGLE.questionJsonOf('route', ROUTE)).toContain(
      '"google.gemini-decision-1":""',
    )
  })

  test('success: the state is measured as it stands escaped inside input', () => {
    const json = JSON.stringify({ text: 'a "b"\n' })

    expect(GOOGLE.stateJsonOf(json)).toBe('{\\"text\\":\\"a \\\\\\"b\\\\\\"\\\\n\\"}')
    expect(GOOGLE.encode('m', JSON.parse(json), { q: ROUTE })).toContain(
      `"input":"${GOOGLE.stateJsonOf(json)}"`,
    )
  })

  test('success: a question is estimated at the 15 tokens Google was measured to count beyond its text', () => {
    // 1, 2, 8 and 32 questions on one state were counted as 1,115, 1,193,
    // 1,632 and 3,406 input tokens: about 74 a question, against about 59
    // in the mod's estimate of the same questions.
    const slope = (3_406 - 1_115) / (32 - 1)

    expect(Math.round(slope)).toBe(74)
    expect(GOOGLE.tokensPerQuestion).toBe(15)
  })
})
