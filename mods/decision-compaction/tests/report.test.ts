import { describe, expect, test } from 'claude-code/testing'

import type { Decision, Outcome } from '../hooks/compact'
import { decisionLinesOf, percentOf, summaryOf } from '../hooks/report'
import { callOf } from './fixtures'

function decisionOf(
  n: number,
  action: Decision['action'],
  tool = 'Read',
): Decision {
  return {
    call: callOf(n, { tool }),
    action,
    keepCall: 0.875,
    keepResult: 0.125,
  }
}

const OUTCOME: Outcome = {
  messages: [],
  decisions: [
    decisionOf(1, 'keep'),
    decisionOf(2, 'truncate'),
    decisionOf(3, 'truncate'),
    decisionOf(4, 'drop'),
    decisionOf(5, 'pinned'),
  ],
  charsBefore: 1000,
  charsAfter: 420,
  stateTokens: 12345,
  stage: 'inputs shortened',
  requests: 3,
  reported: { inputTokens: 11800, cost: 0.0015 },
  shortened: 2,
}

describe('summaryOf', () => {
  test('success: the line names the provider, both token counts and the cost', () => {
    expect(
      summaryOf({
        outcome: OUTCOME,
        route: { provider: 'openrouter', model: '~typesafe/jev-latest' },
      }),
    ).toBe(
      '58% smaller; tool calls: 1 left whole, 2 with the result cut short, ' +
        '1 removed, 1 not judged; ' +
        'openrouter/~typesafe/jev-latest in 3 requests; ' +
        'state about 12345 tokens estimated (inputs shortened), ' +
        '11800 input tokens counted by the provider, cost $0.001500',
    )
  })

  test('success: a provider that reports nothing leaves its figures out', () => {
    expect(
      summaryOf({
        outcome: { ...OUTCOME, requests: 1, reported: {}, stage: 'whole' },
        route: { provider: 'cloudflare', model: 'clef' },
      }),
    ).toBe(
      '58% smaller; tool calls: 1 left whole, 2 with the result cut short, ' +
        '1 removed, 1 not judged; ' +
        'cloudflare/clef in 1 request; state about 12345 tokens estimated (whole)',
    )
  })

  const cut: Record<string, { shortened: number; said: string }> = {
    'success: a result that was to be cut and was too short counts as left whole':
      {
        shortened: 1,
        said: 'tool calls: 2 left whole, 1 with the result cut short, 1 removed, 1 not judged',
      },
    'success: with no result cut the count of cut results is left out': {
      shortened: 0,
      said: 'tool calls: 3 left whole, 1 removed, 1 not judged',
    },
  }

  for (const [name, { shortened, said }] of Object.entries(cut)) {
    test(name, () => {
      expect(
        summaryOf({
          outcome: { ...OUTCOME, shortened },
          route: { provider: 'typesafe', model: 'jev-latest' },
        }).split('; ')[1],
      ).toBe(said)
    })
  }

  test('success: a compaction that asked nothing names no provider', () => {
    expect(
      summaryOf({
        outcome: {
          ...OUTCOME,
          decisions: [],
          charsAfter: 1000,
          stateTokens: 0,
          requests: 0,
          reported: {},
          shortened: 0,
        },
        route: { provider: 'typesafe', model: 'jev-latest' },
      }),
    ).toBe('0% smaller; no answered tool call')
  })

  test('success: a ratio reads as a whole percentage', () => {
    expect(percentOf(0.25)).toBe('25%')
    expect(percentOf(0.586)).toBe('59%')
  })
})

describe('decisionLinesOf', () => {
  test('success: each asked call is one entry with both probabilities', () => {
    expect(decisionLinesOf(OUTCOME.decisions)).toEqual([
      'per-call verdicts: t1 Read -> keep (call 0.88, result 0.13); ' +
        't2 Read -> truncate (call 0.88, result 0.13); ' +
        't3 Read -> truncate (call 0.88, result 0.13); ' +
        't4 Read -> drop (call 0.88, result 0.13)',
    ])
  })

  test('success: with no asked call there is one line saying so', () => {
    expect(decisionLinesOf([decisionOf(1, 'pinned')])).toEqual([
      'per-call verdicts: no tool call was asked about',
    ])
  })

  test('success: a long list is split into numbered lines under the limit', () => {
    const decisions = Array.from({ length: 400 }, (_, index) =>
      decisionOf(index + 1, 'drop', 'mcp__server__a_tool_with_a_long_name'),
    )
    const lines = decisionLinesOf(decisions)

    expect(lines.length > 1).toBe(true)

    for (const line of lines) {
      expect(line.length <= 4096).toBe(true)
    }

    expect(
      lines[0]?.startsWith(`per-call verdicts, part 1 of ${lines.length}: t1 `),
    ).toBe(true)
    expect(
      lines
        .at(-1)
        ?.startsWith(
          `per-call verdicts, part ${lines.length} of ${lines.length}: `,
        ),
    ).toBe(true)
    expect(
      lines
        .flatMap(line =>
          line.replace(/^per-call verdicts, part \d+ of \d+: /, '').split('; '),
        )
        .map(entry => entry.split(' ')[0]),
      'every call appears once, in order',
    ).toEqual(decisions.map(decision => decision.call.id))
  })

  test('success: a smaller limit is honoured', () => {
    const lines = decisionLinesOf(OUTCOME.decisions, 100)

    expect(lines).toEqual([
      'per-call verdicts, part 1 of 4: t1 Read -> keep (call 0.88, result 0.13)',
      'per-call verdicts, part 2 of 4: t2 Read -> truncate (call 0.88, result 0.13)',
      'per-call verdicts, part 3 of 4: t3 Read -> truncate (call 0.88, result 0.13)',
      'per-call verdicts, part 4 of 4: t4 Read -> drop (call 0.88, result 0.13)',
    ])

    for (const line of lines) {
      expect(line.length <= 100).toBe(true)
    }
  })
})
