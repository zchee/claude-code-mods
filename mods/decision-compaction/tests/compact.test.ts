import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  batchesOf,
  budgetOf,
  compact,
  decide,
  demandOf,
  questionsOf,
  rebuild,
  reductionOf,
  untouched,
} from '../hooks/compact'
import type { Ask, Decision, Demand, Scores } from '../hooks/compact'
import { OPENAI } from '../hooks/openai'
import {
  bytesBesideOf,
  exchangeOf,
  limitsOf,
  routeOf,
  wireOf,
} from '../hooks/providers'
import { estimatedTokensOf, stateWithin, pairCalls } from '../hooks/state'
import type { Call } from '../hooks/state'
import { BARE, bytesOf } from '../hooks/systemone'
import type { Questions } from '../hooks/systemone'
import { answering, callOf, calling, said, sessionOf } from './fixtures'

const AMPLE = { stateTokens: 25_000, requestTokens: 1_000_000 }

function callsOf(count: number): Call[] {
  return Array.from({ length: count }, (_, index) => callOf(index + 1))
}

/**
 * Decisions for a session from a score per call id; an id not listed is
 * kept.
 */
function decisionsOf(
  messages: readonly SessionMessage[],
  recent: number,
  scores: Readonly<Record<string, Scores>>,
): Decision[] {
  return pairCalls(messages, recent).map(call =>
    decide(call, scores[call.id] ?? { keepCall: 1, keepResult: 1 }, 0.5),
  )
}

const KEEP_CALL_ONLY: Scores = { keepCall: 0.9, keepResult: 0.1 }
const KEEP_NOTHING: Scores = { keepCall: 0.1, keepResult: 0.1 }

describe('questionsOf', () => {
  test('success: a call gets a call question and a result question', () => {
    const questions = questionsOf(
      callOf(3, { tool: 'Bash', isError: true, resultChars: 42 }),
    )

    expect(Object.keys(questions)).toEqual(['call_t3', 'result_t3'])
    expect(questions.call_t3?.type).toBe('noul')
    expect(questions.result_t3?.type).toBe('noul')
    expect(questions.call_t3?.instructions).toContain('tool call t3 (Bash)')
    expect(questions.result_t3?.instructions).toContain(
      'tool call t3 (Bash), an error, 42 characters long',
    )
  })

  test('success: a successful call is not described as an error', () => {
    const { result_t1: question } = questionsOf(callOf(1, { resultChars: 7 }))

    expect(question?.instructions).toContain(
      'tool call t1 (Read), 7 characters long',
    )
  })
})

describe('demandOf', () => {
  test('success: no calls need nothing', () => {
    expect(demandOf([], BARE)).toEqual({
      longestQuestion: 0,
      batchCalls: 0,
      batchTokens: 0,
      batchBytes: 0,
    })
  })

  test('success: fewer calls than a batch are all counted', () => {
    // Calls with one-digit ids ask questions of exactly the same size.
    const one = demandOf(callsOf(1), BARE)
    const five = demandOf(callsOf(5), BARE)

    expect(one.batchCalls).toBe(1)
    expect(one.longestQuestion > 20).toBe(true)
    expect(one.batchTokens > one.longestQuestion).toBe(true)
    expect(one.batchBytes > one.batchTokens).toBe(true)
    expect(five).toEqual({
      longestQuestion: one.longestQuestion,
      batchCalls: 5,
      batchTokens: one.batchTokens * 5,
      batchBytes: one.batchBytes * 5,
    })
  })

  test('success: the bytes set aside are those of the calls one request may hold under its question cap', () => {
    // Calls with two-digit ids ask questions of exactly the same size.
    const calls = Array.from({ length: 20 }, (_, index) => callOf(index + 10))
    const one = demandOf(calls.slice(0, 1), BARE)
    const capped = demandOf(calls, BARE, 8)
    const open = demandOf(calls, BARE)

    expect(capped.batchCalls).toBe(16)
    expect(capped.batchTokens).toBe(one.batchTokens * 16)
    expect(capped.batchBytes, 'eight questions are four calls').toBe(
      one.batchBytes * 4,
    )
    expect(open.batchBytes).toBe(one.batchBytes * 16)
    expect(demandOf(calls.slice(0, 3), BARE, 8).batchBytes).toBe(
      one.batchBytes * 3,
    )
  })

  test('success: the calls whose questions take the most bytes are the ones set aside', () => {
    // A tool name beyond ASCII takes three bytes a character and one
    // estimated token each, so it weighs more in bytes than in tokens.
    const wide = callOf(9, { tool: '読み込み'.repeat(8) })
    const mixed = demandOf([...callsOf(8), wide], BARE, 4)

    expect(mixed.batchBytes).toBe(
      demandOf([wide], BARE).batchBytes + demandOf(callsOf(1), BARE).batchBytes,
    )
  })

  test('success: of more calls than a batch the sixteen with the longest questions are counted', () => {
    const short = callsOf(40)
    const long = Array.from({ length: 16 }, (_, index) =>
      callOf(index + 41, { tool: 'mcp__a_server__a_tool_with_a_long_name' }),
    )
    const each = demandOf(long.slice(0, 1), BARE).batchTokens
    const mixed = demandOf(
      [...short.slice(0, 20), ...long, ...short.slice(20)],
      BARE,
    )

    expect(each > demandOf(short.slice(0, 1), BARE).batchTokens).toBe(true)
    expect(mixed.batchCalls).toBe(16)
    expect(mixed.batchTokens).toBe(each * 16)
    expect(demandOf(short, BARE).batchTokens < mixed.batchTokens).toBe(true)
  })
})

describe('budgetOf', () => {
  const DEMAND: Demand = {
    longestQuestion: 40,
    batchCalls: 16,
    batchTokens: 1_000,
    batchBytes: 0,
  }

  const budgets: Record<
    string,
    {
      want: [number, number]
      provider: 'typesafe' | 'openrouter' | 'cloudflare'
      model?: string
      demand?: Demand
      expected: object
    }
  > = {
    'success: the default budgets stand at typesafe': {
      want: [25_000, 30_000],
      provider: 'typesafe',
      expected: { stateTokens: 25_000, requestTokens: 30_000 },
    },
    'success: typesafe holds the state to 85% of 32,000 less the longest question':
      {
        want: [100_000, 100_000],
        provider: 'typesafe',
        expected: { stateTokens: 27_160, requestTokens: 54_400 },
      },
    'success: openrouter holds a request to 85% of 32,000, the default included':
      {
        want: [25_000, 30_000],
        provider: 'openrouter',
        expected: { stateTokens: 25_000, requestTokens: 27_200 },
      },
    'success: at openrouter a raised state gives way to the batch it must leave room for':
      {
        want: [100_000, 100_000],
        provider: 'openrouter',
        // 27,200 less the envelope of 32 and the batch of 1,000.
        expected: { stateTokens: 26_168, requestTokens: 27_200 },
      },
    'success: cloudflare clef holds both to 85% of 64,000 and brings its question count':
      {
        want: [100_000, 100_000],
        provider: 'cloudflare',
        // floor(64,000 x 0.85) = 54,400; less 32 and 1,000 for the state.
        expected: { stateTokens: 53_368, requestTokens: 54_400, questions: 64 },
      },
    'success: cloudflare clef-flash holds both to 85% of the 24,000 it reads':
      {
        want: [100_000, 100_000],
        provider: 'cloudflare',
        model: 'clef-flash',
        // floor(24,000 x 0.85) = 20,400; less 32 and 1,000 for the state.
        expected: { stateTokens: 19_368, requestTokens: 20_400, questions: 64 },
      },
    'success: a state budget equal to the request budget is lowered to leave a batch':
      {
        want: [26_000, 26_000],
        provider: 'typesafe',
        // 26,000 less the envelope of 32 and the batch of 1,000.
        expected: { stateTokens: 24_968, requestTokens: 26_000 },
      },
    'success: a larger batch takes more from the state': {
      want: [26_000, 26_000],
      provider: 'typesafe',
      demand: {
        longestQuestion: 90,
        batchCalls: 16,
        batchTokens: 2_880,
        batchBytes: 0,
      },
      expected: { stateTokens: 23_088, requestTokens: 26_000 },
    },
    'success: with one candidate only its two questions are set aside': {
      want: [26_000, 26_000],
      provider: 'typesafe',
      demand: {
        longestQuestion: 70,
        batchCalls: 1,
        batchTokens: 130,
        batchBytes: 0,
      },
      expected: { stateTokens: 25_838, requestTokens: 26_000 },
    },
  }

  for (const [
    name,
    { want, provider, model, demand, expected },
  ] of Object.entries(budgets)) {
    test(name, () => {
      expect(
        budgetOf(
          { maxStateTokens: want[0], maxRequestTokens: want[1] },
          limitsOf(routeOf(provider, model)),
          demand ?? DEMAND,
        ),
      ).toEqual(expected)
    })
  }

  test('success: a fitted state always leaves room for sixteen calls a request', () => {
    const calls = callsOf(300)
    const budget = budgetOf(
      { maxStateTokens: 1_000_000, maxRequestTokens: 1_000_000 },
      limitsOf(routeOf('openrouter')),
      demandOf(calls, BARE),
    )
    const batches = batchesOf(
      calls.slice(0, 256),
      budget.stateTokens,
      budget,
      BARE,
    )

    expect(
      batches.slice(0, -1).every(batch => batch.length >= 16),
      'no request asks about fewer than sixteen calls',
    ).toBe(true)
    expect(batches.length <= 16).toBe(true)
  })

  test('success: clef over openrouter is asked at most 64 questions a request', () => {
    const calls = callsOf(60)
    const limits = limitsOf(routeOf('openrouter', 'cloudflare/clef'))
    const budget = budgetOf(
      { maxStateTokens: 25_000, maxRequestTokens: 30_000 },
      limits,
      demandOf(calls, BARE),
    )
    const batches = batchesOf(calls, 2_000, budget, BARE)

    expect(budget.questions).toBe(64)
    expect(batches.map(batch => batch.length)).toEqual([32, 28])
  })

  const refused: Record<
    string,
    { request: number; demand: Demand; message: string }
  > = {
    'error: a request too small for a state beside a batch is refused': {
      request: 1_032,
      demand: DEMAND,
      message:
        'a request of 1032 tokens has no room for a state beside the ' +
        'questions of 16 calls, which take about 1000',
    },
    'error: the refusal names a single call as one': {
      request: 100,
      demand: {
        longestQuestion: 70,
        batchCalls: 1,
        batchTokens: 130,
        batchBytes: 0,
      },
      message:
        'a request of 100 tokens has no room for a state beside the ' +
        'questions of 1 call, which take about 130',
    },
  }

  for (const [name, { request, demand, message }] of Object.entries(refused)) {
    test(name, () => {
      expect(() =>
        budgetOf(
          { maxStateTokens: 25_000, maxRequestTokens: request },
          limitsOf(routeOf('typesafe')),
          demand,
        ),
      ).toThrow({ message })
    })
  }

  test('success: one token more than the batch needs leaves a state of one token', () => {
    expect(
      budgetOf(
        { maxStateTokens: 25_000, maxRequestTokens: 1_033 },
        limitsOf(routeOf('typesafe')),
        DEMAND,
      ),
    ).toEqual({ stateTokens: 1, requestTokens: 1_033 })
  })
})

describe('batchesOf', () => {
  test('success: a 64-question cap holds 32 calls a batch', () => {
    const batches = batchesOf(
      callsOf(70),
      25_000,
      { ...AMPLE, questions: 64 },
      BARE,
    )

    expect(batches.map(batch => batch.length)).toEqual([32, 32, 6])

    for (const batch of batches) {
      const asked = batch.flatMap(call => Object.keys(questionsOf(call)))

      expect(asked.length <= 64).toBe(true)
    }

    expect(batches.flat().map(call => call.id)).toEqual(
      callsOf(70).map(call => call.id),
    )
  })

  test('success: with no question cap one batch holds every call', () => {
    expect(
      batchesOf(callsOf(70), 25_000, AMPLE, BARE).map(batch => batch.length),
    ).toEqual([70])
  })

  test('success: the token budget splits calls of equal size evenly', () => {
    // Nine calls with one-digit ids ask questions of exactly the same size.
    const calls = callsOf(9)
    const state = 10_000
    let request = state

    // The smallest request budget that admits a single call gives that size.
    for (;;) {
      try {
        batchesOf(
          calls.slice(0, 1),
          state,
          { stateTokens: state, requestTokens: request },
          BARE,
        )
        break
      } catch {
        request++
      }
    }

    const envelope = 32
    const each = request - state - envelope
    const sizes = (room: number) =>
      batchesOf(
        calls,
        state,
        { stateTokens: state, requestTokens: state + envelope + room },
        BARE,
      ).map(batch => batch.length)

    expect(each > 20).toBe(true)
    expect(sizes(each)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
    expect(sizes(each * 3)).toEqual([3, 3, 3])
    expect(sizes(each * 4 - 1)).toEqual([3, 3, 3])
    expect(sizes(each * 4)).toEqual([4, 4, 1])
    expect(sizes(each * 9)).toEqual([9])
  })

  test('success: the tighter of the two limits decides', () => {
    const batches = batchesOf(
      callsOf(10),
      25_000,
      { ...AMPLE, questions: 6 },
      BARE,
    )

    expect(batches.map(batch => batch.length)).toEqual([3, 3, 3, 1])
  })

  test('error: no question fits beside a state that fills the request', () => {
    expect(() =>
      batchesOf(
        callsOf(2),
        29_990,
        { stateTokens: 29_990, requestTokens: 30_000 },
        BARE,
      ),
    ).toThrow({
      message:
        'no question fits beside the state: the state takes about 29990 of ' +
        'the 30000 tokens a request may hold',
    })
  })

  test("error: a cap below one call's two questions is refused", () => {
    expect(() =>
      batchesOf(callsOf(2), 100, { ...AMPLE, questions: 1 }, BARE),
    ).toThrow({
      message:
        'a request may hold 1 questions, fewer than the 2 one call needs',
    })
  })

  test('success: no calls make no batch', () => {
    expect(batchesOf([], 100, AMPLE, BARE)).toEqual([])
  })

  test('success: sixteen requests are the most a compaction is split into', () => {
    expect(
      batchesOf(callsOf(32), 100, { ...AMPLE, questions: 4 }, BARE).map(
        batch => batch.length,
      ),
    ).toEqual(Array.from({ length: 16 }, () => 2))
  })

  test('error: a split into seventeen requests is refused, naming the count', () => {
    expect(() =>
      batchesOf(callsOf(33), 100, { ...AMPLE, questions: 4 }, BARE),
    ).toThrow({
      message:
        'asking about 33 tool calls would take 17 requests, and one ' +
        'compaction sends at most 16',
    })
  })

  test('error: a state that fills the request is refused by its count of requests', () => {
    // Room for the questions of one call at a time: every call would carry
    // the whole state in a request of its own.
    const calls = callsOf(300)
    const one = demandOf(calls.slice(-1), BARE).batchTokens

    expect(() =>
      batchesOf(
        calls,
        25_000,
        { stateTokens: 25_000, requestTokens: 25_000 + 32 + one },
        BARE,
      ),
    ).toThrow({
      message:
        'asking about 300 tool calls would take 300 requests, and one ' +
        'compaction sends at most 16',
    })
  })
})

describe('decide', () => {
  const decided: Record<
    string,
    { scores: Scores; pinned?: boolean; action: string }
  > = {
    'success: a result at the threshold keeps the call whole': {
      scores: { keepCall: 0, keepResult: 0.5 },
      action: 'keep',
    },
    'success: a call at the threshold with a result under it is truncated': {
      scores: { keepCall: 0.5, keepResult: 0.49 },
      action: 'truncate',
    },
    'success: both under the threshold drop the call': {
      scores: { keepCall: 0.49, keepResult: 0.49 },
      action: 'drop',
    },
    'success: a pinned call is never judged': {
      scores: { keepCall: 0, keepResult: 0 },
      pinned: true,
      action: 'pinned',
    },
  }

  for (const [name, { scores, pinned, action }] of Object.entries(decided)) {
    test(name, () => {
      const call = callOf(1, { isPinned: pinned === true })

      expect(decide(call, scores, 0.5)).toEqual({ call, ...scores, action })
    })
  }
})

describe('rebuild', () => {
  test('success: each branch changes only the messages it has to', () => {
    const messages = sessionOf()
    const out = rebuild(
      messages,
      decisionsOf(messages, 2, { t1: KEEP_CALL_ONLY, t2: KEEP_NOTHING }),
      300,
    )

    expect(out).toHaveLength(9)
    expect(out[0]).toBe(messages[0])
    expect(
      out[1],
      'the call of a truncated result is left as the engine has it',
    ).toBe(messages[1])
    expect(out[2] === messages[2]).toBe(false)
    expect(out[2]).toEqual({
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [
        {
          tool_use_id: 'u1',
          text:
            `${'r'.repeat(300)}\n[decision-compaction removed 4700 more ` +
            'characters of this tool output; run the tool again if they are needed]',
          isError: false,
        },
      ],
    })
    expect(
      out[2]?.handle,
      'a rebuilt message carries no handle',
    ).toBeUndefined()
    expect(out[3], 'the dropped call and its result are both gone').toBe(
      messages[5],
    )
    expect(out[4]).toBe(messages[6])
    expect(out[5]).toBe(messages[7])
    expect(out[6]).toBe(messages[8])
    expect(out[7]).toBe(messages[9])
    expect(out[8]).toBe(messages[10])
  })

  test('success: no result is left without its call, and no call without its result', () => {
    const messages = sessionOf()
    const out = rebuild(
      messages,
      decisionsOf(messages, 0, {
        t1: KEEP_NOTHING,
        t3: KEEP_NOTHING,
        t4: KEEP_CALL_ONLY,
      }),
      300,
    )
    const uses = out.flatMap(message =>
      message.toolUses.map(use => use.tool_use_id),
    )
    const results = out.flatMap(message =>
      (message.toolResults ?? []).map(result => result.tool_use_id),
    )

    expect(uses).toEqual(['u2', 'u4'])
    expect(results).toEqual(['u2', 'u4'])
  })

  test('success: keeping everything returns every message as it came', () => {
    const messages = sessionOf()
    const out = rebuild(messages, decisionsOf(messages, 2, {}), 300)

    expect(out).toHaveLength(messages.length)
    out.forEach((message, index) => {
      expect(message).toBe(messages[index])
    })
  })

  test('success: a message keeps its text and its other blocks when one call is dropped', () => {
    const messages = [
      said('start', 'h0'),
      calling(
        'Two calls.',
        [
          ['u1', 'Read', { file_path: 'a' }],
          ['u2', 'Read', { file_path: 'b' }],
        ],
        'h1',
      ),
      answering(
        [
          ['u1', 'a'.repeat(1000)],
          ['u2', 'b'.repeat(1000)],
        ],
        'h2',
      ),
      said('end', 'h3'),
    ]
    const out = rebuild(
      messages,
      decisionsOf(messages, 0, { t1: KEEP_NOTHING }),
      300,
    )

    expect(out).toHaveLength(4)
    expect(out[1]).toEqual({
      role: 'assistant',
      text: 'Two calls.',
      toolUses: [
        { tool_use_id: 'u2', tool: 'Read', input: { file_path: 'b' } },
      ],
    })
    expect(
      out[1]?.toolUses[0],
      "the kept call is the engine's own object",
    ).toBe(messages[1]?.toolUses[1])
    expect(out[2]?.toolResults).toHaveLength(1)
    expect(out[2]?.toolResults?.[0]).toBe(messages[2]?.toolResults?.[1])
    expect(out[1]?.handle).toBeUndefined()
    expect(out[2]?.handle).toBeUndefined()
  })

  test('success: in a rebuilt message the outcome copied on a kept call is cut like its result', () => {
    const messages = [
      said('start'),
      calling('', [
        ['u1', 'Read', { file_path: 'a' }],
        ['u2', 'Bash', { command: 'b' }],
      ]),
      answering([
        ['u1', 'a'.repeat(1000)],
        ['u2', 'b'.repeat(1000), true],
      ]),
      said('end'),
    ]
    const use = messages[1]?.toolUses[1]

    if (use !== undefined) {
      use.text = 'b'.repeat(1000)
      use.isError = true
      use.result = { stdout: 'b'.repeat(1000) }
    }

    const out = rebuild(
      messages,
      decisionsOf(messages, 0, { t1: KEEP_NOTHING, t2: KEEP_CALL_ONLY }),
      10,
    )
    const note =
      `${'b'.repeat(10)}\n[decision-compaction removed 990 more characters of ` +
      'this tool error output; run the tool again if they are needed]'

    expect(out[1]?.toolUses).toHaveLength(1)
    expect(Object.keys(out[1]?.toolUses[0] ?? {}).sort()).toEqual([
      'input',
      'isError',
      'text',
      'tool',
      'tool_use_id',
    ])
    expect(out[1]?.toolUses[0]?.text).toBe(note)
    expect(out[2]?.toolResults).toEqual([
      { tool_use_id: 'u2', text: note, isError: true },
    ])
  })

  test('success: a stored record is left off a truncated result', () => {
    const messages = [
      said('start'),
      calling('Run.', [['u1', 'Bash', { command: 'ls' }]]),
      answering([['u1', 'o'.repeat(2000)]]),
      said('end'),
    ]
    const result = messages[2]?.toolResults?.[0]

    if (result !== undefined) {
      result.result = { stdout: 'o'.repeat(2000) }
    }

    const out = rebuild(
      messages,
      decisionsOf(messages, 0, { t1: KEEP_CALL_ONLY }),
      0,
    )

    expect(Object.keys(out[2]?.toolResults?.[0] ?? {}).sort()).toEqual([
      'isError',
      'text',
      'tool_use_id',
    ])
    expect(out[2]?.toolResults?.[0]?.text).toBe(
      '[decision-compaction removed 2000 more characters of this tool ' +
        'output; run the tool again if they are needed]',
    )
  })

  test('success: a result too short to gain from a cut is left as it is', () => {
    const messages = [
      said('start'),
      calling('Run.', [['u1', 'Bash', { command: 'ls' }]]),
      answering([['u1', 'o'.repeat(420)]]),
      said('end'),
    ]
    const out = rebuild(
      messages,
      decisionsOf(messages, 0, { t1: KEEP_CALL_ONLY }),
      300,
    )

    expect(out[2]).toBe(messages[2])
  })

  test('success: a cut never splits a surrogate pair', () => {
    const messages = [
      said('start'),
      calling('Run.', [['u1', 'Bash', { command: 'ls' }]]),
      answering([['u1', `ab😀${'o'.repeat(500)}`]]),
      said('end'),
    ]
    const out = rebuild(
      messages,
      decisionsOf(messages, 0, { t1: KEEP_CALL_ONLY }),
      3,
    )

    expect(
      out[2]?.toolResults?.[0]?.text.startsWith(
        'ab\n[decision-compaction removed 502 more',
      ),
    ).toBe(true)
  })
})

describe('sizes', () => {
  test('success: a message is sized by its text, its inputs and its results', () => {
    const message: SessionMessage = {
      role: 'assistant',
      text: 'abc',
      toolUses: [
        {
          tool_use_id: 'u1',
          tool: 'Read',
          input: { a: 1 },
          text: 'not counted',
        },
      ],
      toolResults: [{ tool_use_id: 'u0', text: 'four', isError: false }],
    }

    expect(untouched([message], []).charsBefore).toBe(3 + '{"a":1}'.length + 4)
  })

  test('success: the reduction is the share of characters removed', () => {
    expect(reductionOf({ charsBefore: 200, charsAfter: 50 })).toBe(0.75)
    expect(reductionOf({ charsBefore: 200, charsAfter: 200 })).toBe(0)
    expect(reductionOf({ charsBefore: 0, charsAfter: 0 })).toBe(0)
  })

  test('success: a session with no candidate is returned as it is, with no request', () => {
    const messages = sessionOf()
    const calls = pairCalls(messages, 50)
    const outcome = untouched(messages, calls)

    expect(outcome.requests).toBe(0)
    expect(outcome.charsAfter).toBe(outcome.charsBefore)
    expect(outcome.decisions.map(decision => decision.action)).toEqual([
      'pinned',
      'pinned',
      'pinned',
      'pinned',
    ])
    outcome.messages.forEach((message, index) => {
      expect(message).toBe(messages[index])
    })
  })
})

describe('compact', () => {
  /**
   * A fake provider: answers from a score table and keeps what it was asked.
   */
  function fakeAsk(
    scores: Readonly<Record<string, number>>,
    usage: object[] = [],
  ) {
    const asked: { state: unknown; questions: Questions }[] = []
    const ask: Ask = async (state, questions) => {
      asked.push({ state, questions })

      return {
        answers: Object.fromEntries(
          Object.keys(questions)
            .filter(id => scores[id] !== -1)
            .map(id => [id, { type: 'noul', noul: scores[id] ?? 0.9 }]),
        ),
        usage: usage[asked.length - 1] ?? {},
      }
    }

    return { ask, asked }
  }

  function prepared(recent: number) {
    const messages = sessionOf()
    const calls = pairCalls(messages, recent)
    const fitted = stateWithin(messages, calls, {
      maxStateTokens: 25_000,
      preserveRecentMessages: recent,
      goal: 'fix the test',
      wire: BARE,
    })

    return { messages, calls, fitted }
  }

  const SETTINGS = {
    budget: { stateTokens: 25_000, requestTokens: 30_000 },
    wire: BARE,
    keepThreshold: 0.5,
    truncateHeadChars: 300,
  }

  // Lets everything an answer sets off run: reading the answer and sending
  // the next request are a few promise turns apart.
  const quiet = async () => {
    for (let turn = 0; turn < 20; turn++) {
      await Promise.resolve()
    }
  }

  test('success: every batch is asked against the same whole state and the answers are merged', async () => {
    const { messages, calls, fitted } = prepared(2)
    const { ask, asked } = fakeAsk(
      { result_t1: 0.1, call_t2: 0.1, result_t2: 0.1 },
      [
        { input_tokens: 900, cost: 0.001 },
        { input_tokens: 950, cost: 0.002 },
        { input_tokens: 800 },
      ],
    )
    const outcome = await compact(messages, calls, fitted, ask, {
      ...SETTINGS,
      budget: { ...SETTINGS.budget, questions: 2 },
    })

    expect(asked.map(request => Object.keys(request.questions))).toEqual([
      ['call_t1', 'result_t1'],
      ['call_t2', 'result_t2'],
      ['call_t3', 'result_t3'],
    ])

    for (const request of asked) {
      expect(request.state).toBe(fitted.state)
    }

    expect(outcome.requests).toBe(3)
    expect(
      outcome.decisions.map(decision => [decision.call.id, decision.action]),
    ).toEqual([
      ['t1', 'truncate'],
      ['t2', 'drop'],
      ['t3', 'keep'],
      ['t4', 'pinned'],
    ])
    expect(outcome.reported.inputTokens, 'the largest count, not the sum').toBe(
      950,
    )
    expect(outcome.reported.cost).toBe(0.003)
    expect(outcome.stateTokens).toBe(fitted.tokens)
    expect(outcome.stage).toBe('whole')
    expect(outcome.shortened, 'the one truncated result was cut').toBe(1)
    expect(outcome.messages).toHaveLength(9)
    expect(outcome.charsBefore - outcome.charsAfter).toBe(
      // t1 loses 5000 - 300 characters less its note; t2 loses its 4000
      // characters and its input.
      5000 -
        (outcome.messages[2]?.toolResults?.[0]?.text.length ?? 0) +
        4000 +
        '{"command":"npm test"}'.length,
    )
  })

  test('success: a provider that reports no usage leaves the figures absent', async () => {
    const { messages, calls, fitted } = prepared(2)
    const outcome = await compact(
      messages,
      calls,
      fitted,
      fakeAsk({}).ask,
      SETTINGS,
    )

    expect(outcome.requests).toBe(1)
    expect(outcome.reported).toEqual({})
    expect(outcome.charsAfter).toBe(outcome.charsBefore)
  })

  test('error: a reply that lacks one answer fails the compaction', async () => {
    const { messages, calls, fitted } = prepared(2)
    const { ask } = fakeAsk({ result_t2: -1 })

    await expect(
      compact(messages, calls, fitted, ask, SETTINGS),
    ).rejects.toThrow('no probability from 0 to 1 was answered for result_t2')
  })

  test('success: a truncate decision on a result too short to cut is not counted as cut', async () => {
    const { messages, calls, fitted } = prepared(2)
    const scores = {
      result_t1: 0.1,
      result_t2: 0.1,
      result_t3: 0.1,
    }
    // The results are 5000, 4000 and 3000 characters long, and a result is
    // cut only when it is more than 120 characters longer than its head.
    const cutAll = await compact(messages, calls, fitted, fakeAsk(scores).ask, {
      ...SETTINGS,
      truncateHeadChars: 300,
    })
    const cutTwo = await compact(messages, calls, fitted, fakeAsk(scores).ask, {
      ...SETTINGS,
      truncateHeadChars: 2880,
    })
    const cutNone = await compact(
      messages,
      calls,
      fitted,
      fakeAsk(scores).ask,
      {
        ...SETTINGS,
        truncateHeadChars: 4880,
      },
    )

    for (const outcome of [cutAll, cutTwo, cutNone]) {
      expect(outcome.decisions.map(decision => decision.action)).toEqual([
        'truncate',
        'truncate',
        'truncate',
        'pinned',
      ])
    }

    expect(cutAll.shortened).toBe(3)
    expect(cutTwo.shortened).toBe(2)
    expect(cutNone.shortened).toBe(0)
    expect(cutNone.charsAfter, 'nothing was removed').toBe(cutNone.charsBefore)
    expect(
      cutNone.messages.every((message, index) => message === messages[index]),
    ).toBe(true)
  })

  /**
   * A session of `count` answered calls, all candidates, with a state fitted
   * to it, and a budget that puts each call in a request of its own.
   */
  function oneCallARequest(count: number) {
    const messages = [said('go')]

    for (let n = 1; n <= count; n++) {
      messages.push(
        calling('', [[`u${n}`, 'Read', { file_path: `f${n}` }]]),
        answering([[`u${n}`, 'x'.repeat(600)]]),
      )
    }

    messages.push(said('done'))

    const calls = pairCalls(messages, 0)
    const fitted = stateWithin(messages, calls, {
      maxStateTokens: 25_000,
      preserveRecentMessages: 0,
      goal: '',
      wire: BARE,
    })

    return {
      messages,
      calls,
      fitted,
      settings: {
        ...SETTINGS,
        budget: { ...SETTINGS.budget, questions: 2 },
      },
    }
  }

  test('success: three requests are out at a time and the next goes when one comes back', async () => {
    const { messages, calls, fitted, settings } = oneCallARequest(8)
    const waiting: (() => void)[] = []
    const started: string[] = []
    const ask: Ask = (_state, questions) => {
      const ids = Object.keys(questions)

      started.push(ids[0] ?? '')

      return new Promise(resolve => {
        waiting.push(() =>
          resolve({
            answers: Object.fromEntries(
              ids.map(id => [id, { type: 'noul', noul: 0.1 }]),
            ),
            usage: {},
          }),
        )
      })
    }
    const running = compact(messages, calls, fitted, ask, settings)
    const sizes: number[] = []

    // Answer one request at a time, oldest first, and note how many had
    // been started before each answer.
    for (let answered = 0; answered < 8; answered++) {
      await quiet()
      sizes.push(started.length)
      waiting[answered]?.()
    }

    const outcome = await running

    expect(sizes, 'never more than three unanswered').toEqual([
      3, 4, 5, 6, 7, 8, 8, 8,
    ])
    expect(started).toEqual([
      'call_t1',
      'call_t2',
      'call_t3',
      'call_t4',
      'call_t5',
      'call_t6',
      'call_t7',
      'call_t8',
    ])
    expect(outcome.requests).toBe(8)
    expect(outcome.decisions.map(decision => decision.action)).toEqual(
      Array.from({ length: 8 }, () => 'drop'),
    )
  })

  test('error: one failing batch fails the compaction and no further batch is sent', async () => {
    const { messages, calls, fitted, settings } = oneCallARequest(8)
    let count = 0
    const ask: Ask = async () => {
      count++

      throw new Error(`typesafe answered HTTP 401: batch ${count}`)
    }

    await expect(
      compact(messages, calls, fitted, ask, settings),
    ).rejects.toThrow('typesafe answered HTTP 401: batch 1')
    expect(count, 'the three already out, and none of the other five').toBe(3)
  })

  test('success: answers that come back out of order are each applied to their own calls', async () => {
    const { messages, calls, fitted, settings } = oneCallARequest(4)
    const scores: Record<string, number> = {
      call_t1: 0.1,
      result_t1: 0.1,
      call_t2: 0.9,
      result_t2: 0.9,
      call_t3: 0.9,
      result_t3: 0.1,
      call_t4: 0.2,
      result_t4: 0.3,
    }
    const waiting = new Map<string, () => void>()
    const ask: Ask = (_state, questions) =>
      new Promise(resolve => {
        const ids = Object.keys(questions)

        waiting.set(ids[0] ?? '', () =>
          resolve({
            answers: Object.fromEntries(
              ids.map(id => [id, { type: 'noul', noul: scores[id] }]),
            ),
            usage: {},
          }),
        )
      })
    const running = compact(messages, calls, fitted, ask, settings)

    // The third batch answers first, then the second; the fourth goes out
    // only once one of the first three is back, and answers before the
    // first does.
    await quiet()
    waiting.get('call_t3')?.()
    await quiet()
    waiting.get('call_t2')?.()
    await quiet()
    waiting.get('call_t4')?.()
    await quiet()
    waiting.get('call_t1')?.()

    const outcome = await running

    expect(
      outcome.decisions.map(({ call, action, keepCall, keepResult }) => [
        call.id,
        action,
        keepCall,
        keepResult,
      ]),
    ).toEqual([
      ['t1', 'drop', 0.1, 0.1],
      ['t2', 'keep', 0.9, 0.9],
      ['t3', 'truncate', 0.9, 0.1],
      ['t4', 'drop', 0.2, 0.3],
    ])
    expect(outcome.messages.map(message => message.toolUses.length)).toEqual([
      0, 1, 0, 1, 0, 0,
    ])
  })

  test('error: the first failing batch is reported to the caller at once, while the others are still out', async () => {
    const { messages, calls, fitted, settings } = oneCallARequest(4)
    const halts: string[] = []
    let count = 0
    const ask: Ask = () => {
      count++

      return count === 1
        ? Promise.reject(new Error('typesafe answered HTTP 401: batch 1'))
        : new Promise(() => {})
    }

    await expect(
      compact(messages, calls, fitted, ask, {
        ...settings,
        halt: reason => halts.push(reason.message),
      }),
    ).rejects.toThrow('typesafe answered HTTP 401: batch 1')
    expect(halts).toEqual(['typesafe answered HTTP 401: batch 1'])
    expect(count, 'the two others went out before it failed').toBe(3)
  })

  test('success: a tool_use_id carried by more than one call never lets a pinned message be rebuilt', async () => {
    const messages = [
      said('go', 'first'),
      calling('', [['dup', 'Read', { file_path: 'a.ts' }]], 'old-call'),
      answering([['dup', 'a'.repeat(600)]], 'old-result'),
      calling('', [['u2', 'Read', { file_path: 'b.ts' }]], 'call2'),
      answering([['u2', 'b'.repeat(600)]], 'result2'),
      calling('', [['dup', 'Read', { file_path: 'c.ts' }]], 'new-call'),
      answering([['dup', 'c'.repeat(600)]], 'new-result'),
    ]
    const calls = pairCalls(messages, 2)
    const fitted = stateWithin(messages, calls, {
      maxStateTokens: 25_000,
      preserveRecentMessages: 2,
      goal: '',
      wire: BARE,
    })
    const { ask, asked } = fakeAsk({
      call_t1: 0.1,
      result_t1: 0.1,
      call_t2: 0.1,
      result_t2: 0.1,
      call_t3: 0.1,
      result_t3: 0.1,
    })
    const outcome = await compact(messages, calls, fitted, ask, SETTINGS)

    expect(
      asked.map(request => Object.keys(request.questions)),
      'only the call whose id is its own is asked about',
    ).toEqual([['call_t2', 'result_t2']])
    expect(outcome.messages.map(message => message.handle)).toEqual([
      'first',
      'old-call',
      'old-result',
      'new-call',
      'new-result',
    ])
    expect(outcome.messages[3]).toBe(messages[5])
    expect(outcome.messages[4]).toBe(messages[6])
  })

  test('error: a conversation that needs more than sixteen requests makes none', async () => {
    const { messages, calls, fitted, settings } = oneCallARequest(17)
    const { ask, asked } = fakeAsk({})

    await expect(
      compact(messages, calls, fitted, ask, settings),
    ).rejects.toThrow({
      message:
        'asking about 17 tool calls would take 17 requests, and one ' +
        'compaction sends at most 16',
    })
    expect(asked).toEqual([])
  })
})

describe('sizes in the OpenAI wire format', () => {
  test('success: the same questions are estimated larger in the OpenAI form', () => {
    const calls = callsOf(5)
    const bare = demandOf(calls, BARE)
    const openai = demandOf(calls, OPENAI)

    expect(openai.batchTokens > bare.batchTokens).toBe(true)
    expect(openai.longestQuestion > bare.longestQuestion).toBe(true)
  })

  test('success: a request held to the same limits leaves the OpenAI form less room for the state', () => {
    const calls = callsOf(5)
    const want = { maxStateTokens: 1_000_000, maxRequestTokens: 1_000_000 }
    const limits = limitsOf(routeOf('openai'))

    expect(
      budgetOf(want, limits, demandOf(calls, OPENAI)).stateTokens <
        budgetOf(want, limits, demandOf(calls, BARE)).stateTokens,
    ).toBe(true)
  })

  test('success: the state escaped inside input is estimated larger, and fitted to that size', () => {
    const messages = sessionOf()
    const calls = pairCalls(messages, 2)
    const fit = (maxStateTokens: number, wire: typeof BARE) =>
      stateWithin(messages, calls, {
        maxStateTokens,
        preserveRecentMessages: 2,
        goal: 'fix the test',
        wire,
      })
    const bare = fit(25_000, BARE)
    const openai = fit(25_000, OPENAI)

    expect(openai.state).toEqual(bare.state)
    expect(openai.tokens > bare.tokens).toBe(true)

    const tight = fit(bare.tokens, OPENAI)

    expect(
      tight.stage,
      'a budget the bare state just fits is too small escaped',
    ).not.toBe('whole')
    expect(tight.tokens <= bare.tokens).toBe(true)
  })
})

describe('a cap on the request body in bytes', () => {
  // Twelve thousand CJK characters: about as many tokens, far fewer
  // characters than 32 KiB, but three UTF-8 bytes each.
  const CJK = { goal: '日本語の文章'.repeat(2000) }

  test('success: a state that fits the tokens but not 32 KiB is measured in bytes', () => {
    const json = JSON.stringify(CJK)
    const route = routeOf('decisionapi-net')

    expect(estimatedTokensOf(json) < 25_000).toBe(true)
    expect(json.length < 32_768, 'its length alone would pass').toBe(true)
    expect(bytesBesideOf(route, CJK) > 32_768).toBe(true)
    expect(bytesBesideOf(route, CJK)).toBe(
      bytesOf(`{"model":"jev-latest","state":${json},"questions":}`),
    )
  })

  test('error: such a state leaves no question room under the byte cap', () => {
    const state = bytesBesideOf(routeOf('decisionapi-net'), CJK)

    expect(() =>
      batchesOf(
        callsOf(2),
        estimatedTokensOf(JSON.stringify(CJK)),
        { ...AMPLE, bytes: { limit: 32_768, state } },
        BARE,
      ),
    ).toThrow({
      message:
        `no question fits beside the state: the request takes ${state} ` +
        'of the 32768 bytes it may hold before any question',
    })
  })

  test('success: the bytes left beside the state split the calls into batches', () => {
    const calls = callsOf(9)
    const one = demandOf(calls.slice(0, 1), BARE).batchBytes
    const sizes = (room: number) =>
      batchesOf(
        calls,
        100,
        { ...AMPLE, bytes: { limit: 20_000 + room, state: 20_000 } },
        BARE,
      ).map(batch => batch.length)

    expect(sizes(one)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
    expect(sizes(one * 3)).toEqual([3, 3, 3])
    expect(sizes(one * 4 - 1)).toEqual([3, 3, 3])
  })
})

describe('what OpenAI counts for each question', () => {
  test('success: each question is estimated with the 148 tokens OpenAI was measured to add', () => {
    const calls = callsOf(16)
    const bare = demandOf(calls, BARE)
    const openai = demandOf(calls, OPENAI)

    expect(openai.batchTokens >= 32 * 148).toBe(true)
    expect(openai.batchTokens - bare.batchTokens >= 32 * 148).toBe(true)
    expect(openai.longestQuestion >= 148).toBe(true)
  })
})

describe('the bytes a body is counted at', () => {
  // Each question is counted with a comma after it, the last one included,
  // and a question of a map with braces of its own: a list body is counted
  // one byte over, a map body two bytes a question less one.
  const state = { goal: 'fix the parser', conversation: [] }
  const ALL = {
    typesafeApiKey: 'test-typesafe-key',
    decisionsApiKey: 'test-decisions-key',
    decisionapiApiKey: 'test-decisionapi-key',
    openaiApiKey: 'test-openai-key',
  }

  for (const provider of [
    'typesafe',
    'decisions-api-dev',
    'decisionapi-net',
    'openai',
  ] as const) {
    test(`success: ${provider} is counted at or over the body it sends, by at most two bytes a question`, () => {
      const route = routeOf(provider)
      const wire = wireOf(route)

      for (let count = 1; count <= 4; count++) {
        // Calls t7 to t10: ids of one and of two digits, so a
        // real id is both shorter and longer than an alias.
        const calls = Array.from({ length: count }, (_, index) =>
          callOf(index + 7),
        )
        const questions: Questions = Object.fromEntries(
          calls.flatMap(call => Object.entries(questionsOf(call))),
        )
        const counted =
          bytesBesideOf(route, state) + demandOf(calls, wire).batchBytes
        const sent = bytesOf(
          exchangeOf(route, ALL, state, questions).init.body,
        )
        const asked = count * 2

        expect(
          counted >= sent,
          `${asked} questions: counted ${counted}, sent ${sent}`,
        ).toBe(true)
        expect(
          counted - sent <= asked * 2,
          `${asked} questions: counted ${counted}, sent ${sent}`,
        ).toBe(true)
      }
    })
  }

  test('success: decisions-api.dev counts a question at the longest alias it may send, whatever its own id', () => {
    const wire = wireOf(routeOf('decisions-api-dev'))
    const [question] = Object.values(questionsOf(callOf(1)))

    expect(question).toBeDefined()

    if (question !== undefined) {
      expect(wire.questionJsonOf('call_t1', question)).toBe(
        BARE.questionJsonOf('q7', question),
      )
      expect(wire.questionJsonOf('r', question)).toBe(
        BARE.questionJsonOf('q7', question),
      )
    }
  })
})
