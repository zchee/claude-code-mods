import { describe, expect, test } from 'claude-code/testing'

import {
  disputedOf,
  medianOf,
  recordOf,
  summariesOf,
  SWEEP_THRESHOLDS,
} from '../bench/metrics'
import type { Expected, Run, RunRecord } from '../bench/metrics'
import {
  CAVEAT,
  disputedLinesOf,
  scenarioTableOf,
  summaryTableOf,
} from '../bench/table'
import { decide } from '../hooks/compact'
import type { Action, Decision, Outcome, Scores } from '../hooks/compact'
import type { Route } from '../hooks/providers'
import type { Result } from '../hooks/run'
import { callOf } from './fixtures'

const ROUTE: Route = { provider: 'typesafe', model: 'jev-latest' }

/**
 * The probabilities of six judged calls and one pinned one, decided at the
 * mod's default threshold, and what the reference accepts for each. The
 * comments give the action at 0.3, 0.5 and 0.7 and whether the reference
 * accepts it.
 */
const SCORES: readonly Scores[] = [
  // keep, keep, keep: accepted at every threshold.
  { keepCall: 0.9, keepResult: 0.9 },
  // truncate, truncate, truncate: accepted.
  { keepCall: 0.9, keepResult: 0.2 },
  // keep, drop, drop: only 0.3 keeps it, and the reference says keep.
  { keepCall: 0.1, keepResult: 0.35 },
  // keep, keep, drop: only 0.7 removes it, as the reference says to.
  { keepCall: 0.6, keepResult: 0.6 },
  // truncate, drop, drop: accepted.
  { keepCall: 0.4, keepResult: 0.2 },
  // keep, keep, keep: the reference has no label for it.
  { keepCall: 0.9, keepResult: 0.9 },
]

const EXPECTED: Expected = {
  u1: ['keep'],
  u2: ['truncate', 'drop'],
  u3: ['keep'],
  u4: ['drop'],
  u5: ['truncate', 'drop'],
  u7: ['keep'],
}

function decisionsAt(threshold: number): Decision[] {
  return [
    ...SCORES.map((scores, index) =>
      decide(callOf(index + 1), scores, threshold),
    ),
    decide(callOf(7, { isPinned: true }), { keepCall: 1, keepResult: 1 }, 0),
  ]
}

function resultOf(
  decisions: Decision[],
  over: Partial<Outcome> = {},
  route: Route = ROUTE,
): Result {
  return {
    route,
    outcome: {
      messages: [],
      decisions,
      charsBefore: 1000,
      charsAfter: 400,
      stateTokens: 5000,
      stage: 'whole',
      requests: 1,
      reported: { inputTokens: 4800, cost: 0.0002, models: ['jev-1.14'] },
      shortened: 1,
      ...over,
    },
    askedBytes: { limit: 27_852, isHeld: true },
  }
}

const RUN: Run = {
  route: ROUTE,
  scenario: 'fix-test',
  repeat: 1,
  ms: 1234.4,
  result: resultOf(decisionsAt(0.5)),
}

describe('recordOf', () => {
  const record = recordOf(RUN, EXPECTED, 0.5)

  test('success: the scores against the reference are those worked out by hand', () => {
    expect(record.ok).toBe(true)
    expect(record.routeLabel).toBe('typesafe/jev-latest')
    expect(record.judged, 'the pinned call is not judged').toBe(6)
    expect(record.agreement, 'u1, u2 and u5 of six').toBe(3 / 6)
    expect(record.harmfulDrops, 'u3, to be kept, was dropped').toBe(1)
    expect(record.missedReductions, 'u4, to be dropped, was kept').toBe(1)
    expect(record.unlabelled, 'u6 has no label').toBe(1)
    expect(record.counts).toEqual({ keep: 3, truncate: 1, drop: 2, pinned: 1 })
  })

  test('success: the figures of the outcome are carried over', () => {
    expect(record.ms).toBe(1234.4)
    expect(record.reduction).toBe(0.6)
    expect(record.requests).toBe(1)
    expect(record.stateTokens).toBe(5000)
    expect(record.stage).toBe('whole')
    expect(record.inputTokens).toBe(4800)
    expect(record.cost).toBe(0.0002)
    expect(record.askedBytesHeld).toBe(true)
    expect(record.models).toEqual(['jev-1.14'])
  })

  test('success: the sweep recomputes the actions at each threshold', () => {
    expect(SWEEP_THRESHOLDS).toEqual([0.3, 0.5, 0.7])
    expect(record.sweep).toEqual({ '0.3': 4 / 6, '0.5': 3 / 6, '0.7': 4 / 6 })
  })

  test('success: the sweep at 0.5 is the agreement of what decide() did at 0.5', () => {
    const decisions = decisionsAt(0.5)
    const agreed = decisions.filter(
      ({ call, action }) =>
        action !== 'pinned' &&
        (EXPECTED[call.toolUseId] ?? ([] as readonly Action[])).includes(
          action,
        ),
    ).length

    expect(record.sweep?.['0.5']).toBe(agreed / 6)
    expect(record.sweep?.['0.5']).toBe(record.agreement)
  })

  test('success: the headline scores follow the threshold asked for', () => {
    const at07 = recordOf(RUN, EXPECTED, 0.7)

    expect(at07.agreement).toBe(4 / 6)
    expect(at07.harmfulDrops, 'u3 is still dropped at 0.7').toBe(1)
    expect(at07.missedReductions, 'u4 is dropped at 0.7').toBe(0)
    expect(
      at07.counts,
      'the counts are what the run did, whatever the threshold asked for',
    ).toEqual(record.counts)
  })

  test('success: each call is written as ids, action, probabilities and label only', () => {
    expect(record.calls?.[0]).toEqual({
      id: 't1',
      toolUseId: 'u1',
      action: 'keep',
      keepCall: 0.9,
      keepResult: 0.9,
      expected: ['keep'],
    })
    expect(
      record.calls?.map(call => [call.toolUseId, call.action, call.expected]),
    ).toEqual([
      ['u1', 'keep', ['keep']],
      ['u2', 'truncate', ['truncate', 'drop']],
      ['u3', 'drop', ['keep']],
      ['u4', 'keep', ['drop']],
      ['u5', 'drop', ['truncate', 'drop']],
      ['u6', 'keep', undefined],
      ['u7', 'pinned', undefined],
    ])

    const json = JSON.stringify(record)

    for (const key of ['"input"', '"text"', '"state"', '"messages"']) {
      expect(json.includes(key), `no ${key} key`).toBe(false)
    }

    expect(json.includes('src/file'), 'no tool input').toBe(false)
  })

  test('success: a reply that names no model leaves the models absent', () => {
    const plain = recordOf(
      {
        ...RUN,
        result: resultOf(decisionsAt(0.5), { reported: {}, stage: undefined }),
      },
      EXPECTED,
      0.5,
    )

    expect('models' in plain).toBe(false)
    expect('inputTokens' in plain).toBe(false)
    expect('cost' in plain).toBe(false)
    expect('stage' in plain).toBe(false)
  })

  test('success: a run with nothing judged has no agreement and no sweep', () => {
    const pinned = recordOf(
      { ...RUN, result: resultOf(decisionsAt(0.5).slice(6)) },
      EXPECTED,
      0.5,
    )

    expect(pinned.ok).toBe(true)
    expect(pinned.judged).toBe(0)
    expect(pinned.agreement).toBeUndefined()
    expect(pinned.sweep).toBeUndefined()
    expect(pinned.harmfulDrops).toBe(0)
  })

  test('error: a failed run carries its reason and its wall-clock, and no figure', () => {
    const failed = recordOf(
      {
        route: ROUTE,
        scenario: 'fix-test',
        repeat: 1,
        ms: 87,
        failure: 'typesafe answered 401',
      },
      EXPECTED,
      0.5,
    )

    expect(failed).toEqual({
      route: ROUTE,
      routeLabel: 'typesafe/jev-latest',
      scenario: 'fix-test',
      repeat: 1,
      ms: 87,
      ok: false,
      failure: 'typesafe answered 401',
      judged: 0,
    })

    for (const key of ['agreement', 'sweep', 'counts', 'calls', 'requests']) {
      expect(key in failed, `no ${key}`).toBe(false)
    }
  })

  test('error: a run with neither a result nor a reason does not pass as a success', () => {
    const empty = recordOf(
      { route: ROUTE, scenario: 'fix-test', repeat: 1, ms: 0 },
      EXPECTED,
      0.5,
    )

    expect(empty.ok).toBe(false)
    expect(empty.failure).toBe('run() returned no result')
  })
})

describe('medianOf', () => {
  const cases: Record<string, { values: number[]; median?: number }> = {
    'success: no values have no median': { values: [] },
    'success: one value is its own median': { values: [7], median: 7 },
    'success: an odd count takes the middle value, whatever the order': {
      values: [300, 100, 200],
      median: 200,
    },
    'success: an even count takes the mean of the two middle values': {
      values: [40, 10, 30, 20],
      median: 25,
    },
  }

  for (const [name, { values, median }] of Object.entries(cases)) {
    test(name, () => {
      expect(medianOf(values)).toBe(median)
    })
  }

  test('success: the values given are not reordered', () => {
    const values = [3, 1, 2]

    medianOf(values)
    expect(values).toEqual([3, 1, 2])
  })
})

/**
 * A record of a successful run with the figures a summary reads; `over`
 * replaces any of them.
 */
function recordWith(over: Partial<RunRecord> = {}): RunRecord {
  const route = over.route ?? ROUTE

  return {
    route,
    routeLabel: `${route.provider}/${route.model}`,
    scenario: 'fix-test',
    repeat: 1,
    ok: true,
    ms: 100,
    judged: 4,
    agreement: 0.75,
    harmfulDrops: 0,
    missedReductions: 1,
    reduction: 0.5,
    requests: 1,
    stateTokens: 5000,
    stage: 'whole',
    ...over,
  }
}

function failedWith(over: Partial<RunRecord> = {}): RunRecord {
  const route = over.route ?? ROUTE

  return {
    route,
    routeLabel: `${route.provider}/${route.model}`,
    scenario: 'fix-test',
    repeat: 1,
    ok: false,
    failure: 'typesafe answered 500',
    ms: 5,
    judged: 0,
    ...over,
  }
}

function callsWith(
  actions: readonly Action[],
): NonNullable<RunRecord['calls']> {
  return actions.map((action, index) => ({
    id: `t${index + 1}`,
    toolUseId: `u${index + 1}`,
    action,
    keepCall: 0.5,
    keepResult: 0.5,
  }))
}

describe('summariesOf', () => {
  const OTHER: Route = { provider: 'openrouter', model: '~typesafe/jev-latest' }

  test('success: one summary per route, in the order the routes first appear', () => {
    const summaries = summariesOf([
      recordWith({ route: OTHER }),
      recordWith(),
      recordWith({ route: OTHER, scenario: 'retry' }),
    ])

    expect(
      summaries.map(summary => [summary.routeLabel, summary.runs]),
    ).toEqual([
      ['openrouter/~typesafe/jev-latest', 2],
      ['typesafe/jev-latest', 1],
    ])
  })

  test('success: latency is the median of the runs that succeeded, and the rates are their means', () => {
    const [summary] = summariesOf([
      recordWith({ ms: 300, agreement: 1, reduction: 0.2 }),
      recordWith({ ms: 100, agreement: 0.5, reduction: 0.4 }),
      recordWith({ ms: 200, agreement: 0.75, reduction: 0.6 }),
      failedWith({ ms: 5 }),
    ])

    expect(summary?.runs).toBe(4)
    expect(summary?.failed).toBe(1)
    expect(summary?.medianMs, 'the fast failure is not a latency').toBe(200)
    expect(summary?.agreement).toBe(0.75)
    expect(summary?.reduction).toBe((0.2 + 0.4 + 0.6) / 3)
  })

  test('success: counts are summed, and tokens and cost only over the runs that reported them', () => {
    const [summary] = summariesOf([
      recordWith({
        harmfulDrops: 1,
        missedReductions: 2,
        requests: 3,
        inputTokens: 4000,
        cost: 0.0001,
      }),
      recordWith({
        harmfulDrops: 2,
        missedReductions: 0,
        requests: 1,
        inputTokens: 1000,
      }),
      recordWith({ harmfulDrops: 0, missedReductions: 1, requests: 2 }),
    ])

    expect(summary?.harmfulDrops).toBe(3)
    expect(summary?.missedReductions).toBe(3)
    expect(summary?.requests).toBe(6)
    expect(summary?.inputTokens).toBe(5000)
    expect(summary?.cost).toBe(0.0001)
  })

  test('success: a route that reported no tokens and no cost has none', () => {
    const [summary] = summariesOf([recordWith()])

    expect('inputTokens' in (summary ?? {})).toBe(false)
    expect('cost' in (summary ?? {})).toBe(false)
  })

  test('error: a route whose every run failed has no figure but its counts of runs', () => {
    const [summary] = summariesOf([failedWith(), failedWith({ repeat: 2 })])

    expect(summary).toEqual({
      route: ROUTE,
      routeLabel: 'typesafe/jev-latest',
      runs: 2,
      failed: 2,
      suspect: false,
    })
  })

  test('success: consistency is the share of judged calls whose action held across repeats', () => {
    const [summary] = summariesOf([
      recordWith({
        repeat: 1,
        calls: callsWith(['keep', 'drop', 'truncate', 'keep', 'pinned']),
      }),
      recordWith({
        repeat: 2,
        calls: callsWith(['keep', 'drop', 'truncate', 'drop', 'pinned']),
      }),
    ])

    expect(
      summary?.consistency,
      'u4 flipped; the pinned u5 is not counted',
    ).toBe(0.75)
  })

  test('success: consistency counts a call missing from one repeat as changed, and ignores a failed repeat', () => {
    const [summary] = summariesOf([
      recordWith({ repeat: 1, calls: callsWith(['keep', 'drop']) }),
      recordWith({ repeat: 2, calls: callsWith(['keep']) }),
      failedWith({ repeat: 3 }),
    ])

    expect(summary?.consistency).toBe(0.5)
  })

  test('success: a scenario run once gives no consistency', () => {
    const [summary] = summariesOf([
      recordWith({ calls: callsWith(['keep']) }),
      recordWith({ scenario: 'retry', calls: callsWith(['drop']) }),
    ])

    expect(summary?.consistency).toBeUndefined()
  })

  test('success: the models and stages of every run are merged, each once, in first-seen order', () => {
    const [summary] = summariesOf([
      recordWith({ models: ['jev-1.14'] }),
      recordWith({
        models: ['jev-1.13', 'jev-1.14'],
        stage: 'inputs shortened',
      }),
      recordWith(),
    ])

    expect(summary?.models).toEqual(['jev-1.14', 'jev-1.13'])
    expect(summary?.stages).toEqual(['whole', 'inputs shortened'])
  })

  const suspects: Record<string, { records: RunRecord[]; suspect: boolean }> =
    {
      'success: near chance on both unambiguous scenarios is suspect': {
        records: [
          recordWith({ scenario: 'all-needed', agreement: 0.4 }),
          recordWith({ scenario: 'retry', agreement: 0.6 }),
          recordWith({ scenario: 'fix-test', agreement: 0.9 }),
        ],
        suspect: true,
      },
      'success: near chance on one unambiguous scenario only is not suspect': {
        records: [
          recordWith({ scenario: 'all-needed', agreement: 0.5 }),
          recordWith({ scenario: 'retry', agreement: 0.9 }),
          recordWith({ scenario: 'fix-test', agreement: 0.9 }),
        ],
        suspect: false,
      },
      'success: the mean over repeats is what is held to the band': {
        records: [
          recordWith({ scenario: 'all-needed', agreement: 0.2 }),
          recordWith({ scenario: 'all-needed', repeat: 2, agreement: 0.8 }),
          recordWith({ scenario: 'retry', agreement: 0.5 }),
        ],
        suspect: true,
      },
      'success: just outside the band is not suspect': {
        records: [
          recordWith({ scenario: 'all-needed', agreement: 0.39 }),
          recordWith({ scenario: 'retry', agreement: 0.5 }),
        ],
        suspect: false,
      },
      'success: with only the unambiguous scenarios run, near chance is suspect':
        {
          records: [
            recordWith({ scenario: 'all-needed', agreement: 0.5 }),
            recordWith({ scenario: 'retry', agreement: 0.5 }),
          ],
          suspect: true,
        },
      'error: a route whose other scenarios all failed is a failure, not a suspect':
        {
          records: [
            recordWith({ scenario: 'all-needed', agreement: 0.5 }),
            recordWith({ scenario: 'retry', agreement: 0.5 }),
            failedWith({ scenario: 'fix-test' }),
            failedWith({ scenario: 'large' }),
          ],
          suspect: false,
        },
      'success: a route that ran no unambiguous scenario is not suspect': {
        records: [recordWith({ scenario: 'fix-test', agreement: 0.5 })],
        suspect: false,
      },
      'error: failed runs of the unambiguous scenarios make no suspect': {
        records: [
          failedWith({ scenario: 'all-needed' }),
          failedWith({ scenario: 'retry' }),
          recordWith({ scenario: 'fix-test', agreement: 0.5 }),
        ],
        suspect: false,
      },
    }

  for (const [name, { records, suspect }] of Object.entries(suspects)) {
    test(name, () => {
      expect(summariesOf(records)[0]?.suspect).toBe(suspect)
    })
  }

  /**
   * The counts of a run that judged `keep + truncate + drop` calls.
   */
  const countsOf = (keep: number, truncate: number, drop: number) => ({
    judged: keep + truncate + drop,
    counts: { keep, truncate, drop, pinned: 1 },
  })

  const degenerates: Record<
    string,
    { records: RunRecord[]; degenerate?: 'keeps nothing' | 'keeps everything' }
  > = {
    'success: a route that cut or dropped every judged call keeps nothing': {
      records: [
        recordWith(countsOf(0, 2, 5)),
        recordWith({ scenario: 'retry', ...countsOf(0, 0, 4) }),
      ],
      degenerate: 'keeps nothing',
    },
    'success: a route that cut every judged call keeps nothing': {
      records: [recordWith(countsOf(0, 3, 0))],
      degenerate: 'keeps nothing',
    },
    'success: a route that kept every judged call keeps everything': {
      records: [
        recordWith(countsOf(6, 0, 0)),
        recordWith({ scenario: 'retry', ...countsOf(4, 0, 0) }),
      ],
      degenerate: 'keeps everything',
    },
    'success: one kept call among dropped ones is no mark': {
      records: [
        recordWith(countsOf(0, 0, 5)),
        recordWith({ scenario: 'retry', ...countsOf(1, 0, 3) }),
      ],
    },
    'success: one dropped call among kept ones is no mark': {
      records: [
        recordWith(countsOf(6, 0, 0)),
        recordWith({ scenario: 'retry', ...countsOf(3, 0, 1) }),
      ],
    },
    'error: a failed run has no say in the mark': {
      records: [
        recordWith(countsOf(0, 1, 4)),
        failedWith({ scenario: 'retry', ...countsOf(3, 0, 0) }),
      ],
      degenerate: 'keeps nothing',
    },
    'success: a route that judged no call has no mark': {
      records: [recordWith(countsOf(0, 0, 0))],
    },
    'error: a route whose every run failed has no mark': {
      records: [failedWith(), failedWith({ repeat: 2 })],
    },
    'success: a run without counts is left out of the mark': {
      records: [
        recordWith(),
        recordWith({ scenario: 'retry', ...countsOf(2, 0, 0) }),
      ],
      degenerate: 'keeps everything',
    },
  }

  for (const [name, { records, degenerate }] of Object.entries(degenerates)) {
    test(name, () => {
      const [summary] = summariesOf(records)

      expect(summary?.degenerate).toBe(degenerate)
      expect('degenerate' in (summary ?? {})).toBe(degenerate !== undefined)
    })
  }
})

describe('scenarioTableOf', () => {
  const record = recordOf(RUN, EXPECTED, 0.5)

  test('success: one known record renders as a titled, aligned table', () => {
    expect(scenarioTableOf('fix-test', [record])).toBe(
      [
        'scenario fix-test',
        'route                ok/FAIL  requests    ms  stage  state tokens  asked bytes held  reduction  kept/cut/dropped  agreement  harmful  tokens counted       cost  answered as',
        '-------------------  -------  --------  ----  -----  ------------  ----------------  ---------  ----------------  ---------  -------  --------------  ---------  -----------',
        'typesafe/jev-latest  ok              1  1234  whole          5000  yes                     60%             3/1/2        50%        1            4800  $0.000200  jev-1.14',
      ].join('\n'),
    )
  })

  test('error: a failed run shows its reason in the last column and no figure but its wall-clock', () => {
    const failed = recordOf(
      {
        route: { provider: 'cloudflare', model: 'clef-flash' },
        scenario: 'fix-test',
        repeat: 1,
        ms: 87.6,
        failure: 'cloudflare answered 401:\n  unauthorized',
      },
      EXPECTED,
      0.5,
    )
    const lines = scenarioTableOf('fix-test', [record, failed]).split('\n')

    expect(lines).toHaveLength(5)
    expect(lines[4]?.split(/ {2,}/)).toEqual([
      'cloudflare/clef-flash',
      'FAIL',
      '-',
      '88',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      'cloudflare answered 401: unauthorized',
    ])
  })

  test('success: a cut stage, its tokens and an unheld byte cap are shown, and an absent one as -', () => {
    const cut = recordOf(
      {
        ...RUN,
        route: { provider: 'openrouter', model: '~typesafe/jev-latest' },
        result: {
          ...resultOf(decisionsAt(0.5), {
            stage: 'inputs shortened',
            stateTokens: 8340,
          }),
          askedBytes: { limit: 20_480, isHeld: false },
        },
      },
      EXPECTED,
      0.5,
    )
    const unstaged = recordOf(
      {
        ...RUN,
        route: { provider: 'cloudflare', model: 'clef-flash' },
        result: { ...resultOf(decisionsAt(0.5), { stage: undefined }) },
      },
      EXPECTED,
      0.5,
    )

    delete unstaged.askedBytesHeld

    const lines = scenarioTableOf('fix-test', [cut, unstaged]).split('\n')

    expect(lines[3]?.split(/ {2,}/).slice(0, 7)).toEqual([
      'openrouter/~typesafe/jev-latest',
      'ok',
      '1',
      '1234',
      'inputs shortened',
      '8340',
      'no',
    ])
    expect(lines[4]?.split(/ {2,}/).slice(0, 7)).toEqual([
      'cloudflare/clef-flash',
      'ok',
      '1',
      '1234',
      '-',
      '5000',
      '-',
    ])
  })

  test('success: records of other scenarios are left out', () => {
    const lines = scenarioTableOf('retry', [record]).split('\n')

    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('scenario retry')
  })

  test('success: repeats of a scenario are told apart by number', () => {
    const lines = scenarioTableOf('fix-test', [
      record,
      { ...record, repeat: 2 },
    ]).split('\n')

    expect(lines[3]?.startsWith('typesafe/jev-latest #1  ')).toBe(true)
    expect(lines[4]?.startsWith('typesafe/jev-latest #2  ')).toBe(true)
  })

  test('success: no line ends in a space', () => {
    for (const line of scenarioTableOf('fix-test', [
      record,
      { ...record, models: undefined },
    ]).split('\n')) {
      expect(line).toBe(line.trimEnd())
    }
  })
})

describe('summaryTableOf', () => {
  test('success: one known summary renders as an aligned table', () => {
    const summaries = summariesOf([
      recordOf(RUN, EXPECTED, 0.5),
      recordOf({ ...RUN, repeat: 2, ms: 1000 }, EXPECTED, 0.5),
    ])

    expect(summaries[0]?.medianMs).toBe((1234.4 + 1000) / 2)
    expect(summaryTableOf(summaries)).toBe(
      [
        'route                runs  failed  median ms  stages  agreement  harmful  missed  reduction  requests  tokens       cost  consistency  suspect  degenerate  answered as',
        '-------------------  ----  ------  ---------  ------  ---------  -------  ------  ---------  --------  ------  ---------  -----------  -------  ----------  -----------',
        'typesafe/jev-latest     2       0       1117  whole         50%        2       2        60%         2    9600  $0.000400         100%  -        -           jev-1.14',
      ].join('\n'),
    )
  })

  test('success: a suspect route says so, and a route with no figure shows none', () => {
    const lines = summaryTableOf(
      summariesOf([
        recordWith({ scenario: 'all-needed', agreement: 0.5 }),
        recordWith({ scenario: 'retry', agreement: 0.5 }),
        failedWith({ route: { provider: 'cloudflare', model: 'clef-flash' } }),
      ]),
    ).split('\n')

    expect(lines[2]?.split(/ {2,}/)).toEqual([
      'typesafe/jev-latest',
      '2',
      '0',
      '100',
      'whole',
      '50%',
      '0',
      '2',
      '50%',
      '2',
      '-',
      '-',
      '-',
      'suspect',
      '-',
      '-',
    ])
    expect(lines[3]?.split(/ {2,}/)).toEqual([
      'cloudflare/clef-flash',
      '1',
      '1',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
      '-',
    ])
  })

  test('success: the distinct stages of a route are joined with a slash', () => {
    const lines = summaryTableOf(
      summariesOf([
        recordWith({ stage: 'whole' }),
        recordWith({ scenario: 'large', stage: 'inputs shortened' }),
        recordWith({ scenario: 'retry', stage: 'whole' }),
      ]),
    ).split('\n')

    expect(lines[2]?.split(/ {2,}/)[4]).toBe('whole/inputs shortened')
  })

  test('success: a route that keeps nothing and one that keeps everything say so in the degenerate column', () => {
    const OTHER: Route = { provider: 'cloudflare', model: 'clef' }
    const lines = summaryTableOf(
      summariesOf([
        recordWith({
          judged: 4,
          counts: { keep: 0, truncate: 1, drop: 3, pinned: 0 },
        }),
        recordWith({
          route: OTHER,
          judged: 4,
          counts: { keep: 4, truncate: 0, drop: 0, pinned: 0 },
        }),
      ]),
    ).split('\n')
    const column = lines[0]?.split(/ {2,}/).indexOf('degenerate') ?? -1

    expect(column, 'the column follows suspect').toBe(14)
    expect(lines[2]?.split(/ {2,}/)[column]).toBe('keeps nothing')
    expect(lines[3]?.split(/ {2,}/)[column]).toBe('keeps everything')
  })
})

describe('disputedOf', () => {
  const ROUTE_B: Route = {
    provider: 'openrouter',
    model: '~typesafe/jev-latest',
  }

  /**
   * An ok record of one route whose labelled calls got the given actions.
   */
  const judgedBy = (
    route: Route,
    actions: readonly [string, Action, readonly Action[]][],
    over: Partial<RunRecord> = {},
  ) =>
    recordWith({
      route,
      calls: actions.map(([toolUseId, action, expected], index) => ({
        id: `t${index + 1}`,
        toolUseId,
        action,
        keepCall: 0.5,
        keepResult: 0.5,
        expected,
      })),
      ...over,
    })

  const ROUTE_C: Route = { provider: 'cloudflare', model: 'clef' }

  test('success: a call every ok route answers against its label is listed, with no route agreeing', () => {
    const disputed = disputedOf([
      judgedBy(ROUTE, [
        ['u1', 'keep', ['keep']],
        ['u2', 'keep', ['drop']],
      ]),
      judgedBy(ROUTE_B, [
        ['u1', 'keep', ['keep']],
        ['u2', 'truncate', ['drop']],
      ]),
      judgedBy(ROUTE_B, [['u2', 'keep', ['drop']]], { repeat: 2 }),
      // A failed run has no say, whatever its calls.
      failedWith({
        route: { provider: 'cloudflare', model: 'clef' },
        calls: [
          {
            id: 't2',
            toolUseId: 'u2',
            action: 'drop',
            keepCall: 0,
            keepResult: 0,
            expected: ['drop'],
          },
        ],
      }),
    ])

    expect(disputed).toEqual([
      {
        scenario: 'fix-test',
        toolUseId: 'u2',
        expected: ['drop'],
        actions: {
          'typesafe/jev-latest': 'keep',
          'openrouter/~typesafe/jev-latest': 'truncate/keep',
        },
        agreeing: [],
      },
    ])
    expect(disputedLinesOf(disputed)).toBe(
      'disputed fix-test u2: labelled drop, answered keep by ' +
        'typesafe/jev-latest, truncate/keep by ' +
        'openrouter/~typesafe/jev-latest; agreed by: none',
    )
  })

  test('success: two of three routes disagreeing is a majority, and the one that agreed is named', () => {
    const disputed = disputedOf([
      judgedBy(ROUTE, [['u1', 'drop', ['keep']]]),
      judgedBy(ROUTE_B, [['u1', 'keep', ['keep']]]),
      judgedBy(ROUTE_C, [['u1', 'truncate', ['keep']]]),
    ])

    expect(disputed).toEqual([
      {
        scenario: 'fix-test',
        toolUseId: 'u1',
        expected: ['keep'],
        actions: {
          'typesafe/jev-latest': 'drop',
          'openrouter/~typesafe/jev-latest': 'keep',
          'cloudflare/clef': 'truncate',
        },
        agreeing: ['openrouter/~typesafe/jev-latest'],
      },
    ])
    expect(disputedLinesOf(disputed)).toBe(
      'disputed fix-test u1: labelled keep, answered drop by ' +
        'typesafe/jev-latest, keep by openrouter/~typesafe/jev-latest, ' +
        'truncate by cloudflare/clef; agreed by: ' +
        'openrouter/~typesafe/jev-latest',
    )
  })

  test('success: one of three routes disagreeing is no majority', () => {
    expect(
      disputedOf([
        judgedBy(ROUTE, [['u1', 'drop', ['keep']]]),
        judgedBy(ROUTE_B, [['u1', 'keep', ['keep']]]),
        judgedBy(ROUTE_C, [['u1', 'keep', ['keep']]]),
      ]),
    ).toEqual([])
  })

  test('success: one of two routes disagreeing is a tie, not a majority', () => {
    expect(
      disputedOf([
        judgedBy(ROUTE, [['u1', 'drop', ['keep']]]),
        judgedBy(ROUTE_B, [['u1', 'keep', ['keep']]]),
      ]),
    ).toEqual([])
  })

  test('error: failed runs neither make nor break a majority', () => {
    const failedAgreeing = (route: Route, repeat: number) =>
      failedWith({
        route,
        repeat,
        calls: [
          {
            id: 't1',
            toolUseId: 'u1',
            action: 'keep',
            keepCall: 1,
            keepResult: 1,
            expected: ['keep'],
          },
        ],
      })
    const disputed = disputedOf([
      judgedBy(ROUTE, [['u1', 'drop', ['keep']]]),
      judgedBy(ROUTE_B, [['u1', 'drop', ['keep']]]),
      judgedBy(ROUTE_C, [['u1', 'keep', ['keep']]]),
      // Two more routes whose runs failed: had they counted, two of five
      // disagreeing would be no majority.
      failedAgreeing(
        { provider: 'perplexity', model: 'pplx-decider-v1.1-27b' },
        1,
      ),
      failedAgreeing({ provider: 'openai', model: 'gpt-6-luna' }, 1),
      // A failed repeat of a disagreeing route does not make it agree.
      failedAgreeing(ROUTE, 2),
    ])

    expect(disputed.map(call => [call.toolUseId, call.agreeing])).toEqual([
      ['u1', ['cloudflare/clef']],
    ])
  })

  test('success: with every label met by some route, nothing is disputed', () => {
    const disputed = disputedOf([
      judgedBy(ROUTE, [
        ['u1', 'keep', ['keep']],
        ['u2', 'drop', ['truncate', 'drop']],
      ]),
      judgedBy(ROUTE_B, [
        ['u1', 'keep', ['keep']],
        ['u2', 'truncate', ['truncate', 'drop']],
      ]),
    ])

    expect(disputed).toEqual([])
    expect(disputedLinesOf(disputed)).toBe('no call disputed by most routes')
  })

  test('success: of two routes, one that agrees in any repeat keeps a call off the list', () => {
    expect(
      disputedOf([
        judgedBy(ROUTE, [['u2', 'keep', ['drop']]]),
        judgedBy(ROUTE_B, [['u2', 'drop', ['drop']]]),
        judgedBy(ROUTE_B, [['u2', 'keep', ['drop']]], { repeat: 2 }),
      ]),
    ).toEqual([])
  })

  test('success: unlabelled and pinned calls are never disputed, and the same id in two scenarios is two calls', () => {
    const disputed = disputedOf([
      recordWith({
        calls: [
          {
            id: 't1',
            toolUseId: 'u1',
            action: 'keep',
            keepCall: 1,
            keepResult: 1,
          },
          {
            id: 't9',
            toolUseId: 'u9',
            action: 'pinned',
            keepCall: 1,
            keepResult: 1,
          },
        ],
      }),
      judgedBy(ROUTE, [['u2', 'keep', ['drop']]], { scenario: 'retry' }),
      judgedBy(ROUTE, [['u2', 'drop', ['drop']]], { scenario: 'large' }),
    ])

    expect(disputed.map(call => `${call.scenario} ${call.toolUseId}`)).toEqual([
      'retry u2',
    ])
  })
})

describe('CAVEAT', () => {
  test('success: the caveat says what is compared and what the OpenRouter-only routes share', () => {
    expect(CAVEAT).toContain('routes as the mod drives them')
    expect(CAVEAT).toContain('not the raw quality')
    expect(CAVEAT).toContain('27,200-token state cap')
    expect(CAVEAT).toContain('byte cap it asks for')
    expect(CAVEAT).toContain('held to its window')
    expect(CAVEAT).not.toContain('equal footing')
    expect(CAVEAT.includes('\n'), 'one paragraph').toBe(false)
  })
})
