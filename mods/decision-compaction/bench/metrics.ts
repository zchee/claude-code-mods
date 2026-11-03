import { decide, reductionOf } from '../hooks/compact'
import type { Action, Decision } from '../hooks/compact'
import type { Route } from '../hooks/providers'
import { labelOf } from '../hooks/route'
import type { Result } from '../hooks/run'

/**
 * The actions a reference accepts for each judged call, by its
 * `tool_use_id`. A set rather than one action, because more than one answer
 * can be right: a result that is no longer needed may be cut or removed.
 */
export type Expected = Readonly<
  Record<string, readonly Exclude<Action, 'pinned'>[]>
>

/**
 * The thresholds agreement is recomputed at from the recorded
 * probabilities, so the sensitivity to `keepThreshold` costs no request.
 */
export const SWEEP_THRESHOLDS: readonly number[] = [0.3, 0.5, 0.7]

/**
 * The scenarios whose labels leave no judgement call: every call is needed,
 * or every failure is obsolete once the command succeeded. A route near
 * chance on them answers questions it does not read the way the mod asks
 * them.
 */
const UNAMBIGUOUS_SCENARIOS: readonly string[] = ['all-needed', 'retry']

/**
 * The agreement on the unambiguous scenarios that marks a route as
 * suspect: what a coin would score.
 */
const SUSPECT_LOW = 0.4
const SUSPECT_HIGH = 0.6

/**
 * One compaction as the bench ran it.
 */
export type Run = {
  route: Route
  scenario: string
  repeat: number
  /** Wall-clock of run(), milliseconds. */
  ms: number
  result?: Result
  /** The redacted reason, when run() threw. */
  failure?: string
}

/**
 * One call of a run as it is written out: ids, the action and the two
 * probabilities, and the reference. Nothing of the call's input or output
 * goes into it, so the record can be shared.
 */
export type CallRecord = {
  id: string
  toolUseId: string
  action: Action
  keepCall: number
  keepResult: number
  expected?: readonly Action[]
}

/**
 * The figures of one run. The scores against the reference (`agreement`,
 * `harmfulDrops`, `missedReductions`, `unlabelled`, `sweep`) are recomputed
 * from the recorded probabilities at the threshold asked for; `counts`,
 * `reduction` and the actions in `calls` are what the mod in fact did. The
 * two agree when the threshold asked for is the one the run was configured
 * with.
 */
export type RunRecord = {
  route: Route
  routeLabel: string
  scenario: string
  repeat: number
  ok: boolean
  failure?: string
  ms: number
  /** Decisions whose action is not 'pinned'. */
  judged: number
  /** The share of judged calls whose action the reference accepts. */
  agreement?: number
  /** Calls the reference says to keep whole that were cut or removed. */
  harmfulDrops?: number
  /** Calls the reference says to cut or remove that were kept whole. */
  missedReductions?: number
  /** Judged calls the reference has no label for; they count as disagreeing. */
  unlabelled?: number
  /** The agreement at each threshold, by the threshold as a string. */
  sweep?: Record<string, number>
  counts?: { keep: number; truncate: number; drop: number; pinned: number }
  reduction?: number
  requests?: number
  stateTokens?: number
  stage?: string
  inputTokens?: number
  cost?: number
  askedBytesHeld?: boolean
  models?: string[]
  /** Per call, for --out. No text. */
  calls?: CallRecord[]
}

/**
 * How the judged calls of a run score against the reference when their
 * actions are decided at one threshold.
 */
type Scored = {
  agreement?: number
  harmfulDrops: number
  missedReductions: number
  unlabelled: number
}

function scoredAt(
  judged: readonly Decision[],
  expected: Expected,
  threshold: number,
): Scored {
  let agreed = 0
  let harmfulDrops = 0
  let missedReductions = 0
  let unlabelled = 0

  for (const decision of judged) {
    const { action } = decide(
      decision.call,
      { keepCall: decision.keepCall, keepResult: decision.keepResult },
      threshold,
    )
    const accepted: readonly Action[] | undefined =
      expected[decision.call.toolUseId]

    if (accepted === undefined) {
      unlabelled++
      continue
    }

    if (accepted.includes(action)) {
      agreed++
    }

    if (
      accepted.length === 1 &&
      accepted[0] === 'keep' &&
      (action === 'truncate' || action === 'drop')
    ) {
      harmfulDrops++
    }

    if (!accepted.includes('keep') && action === 'keep') {
      missedReductions++
    }
  }

  return {
    ...(judged.length === 0 ? {} : { agreement: agreed / judged.length }),
    harmfulDrops,
    missedReductions,
    unlabelled,
  }
}

function countOf(decisions: readonly Decision[], action: Action): number {
  return decisions.filter(decision => decision.action === action).length
}

/**
 * The figures of one run against the reference.
 *
 * @param run the run, with its result or the reason it failed
 * @param expected the actions the reference accepts, by `tool_use_id`
 * @param keepThreshold the threshold the scores are taken at; the run's
 * configured one for the headline figures
 * @returns the record; a failed run carries its reason and no figure but its
 * wall-clock
 */
export function recordOf(
  run: Run,
  expected: Expected,
  keepThreshold: number,
): RunRecord {
  const base = {
    route: run.route,
    routeLabel: labelOf(run.route),
    scenario: run.scenario,
    repeat: run.repeat,
    ms: run.ms,
  }

  if (run.result === undefined || run.failure !== undefined) {
    return {
      ...base,
      ok: false,
      failure: run.failure ?? 'run() returned no result',
      judged: 0,
    }
  }

  const { outcome, askedBytes } = run.result
  const { decisions, reported } = outcome
  const judged = decisions.filter(decision => decision.action !== 'pinned')
  const scored = scoredAt(judged, expected, keepThreshold)
  const sweep: Record<string, number> = {}

  for (const threshold of SWEEP_THRESHOLDS) {
    const { agreement } = scoredAt(judged, expected, threshold)

    if (agreement !== undefined) {
      sweep[String(threshold)] = agreement
    }
  }

  return {
    ...base,
    ok: true,
    judged: judged.length,
    ...scored,
    ...(judged.length === 0 ? {} : { sweep }),
    counts: {
      keep: countOf(decisions, 'keep'),
      truncate: countOf(decisions, 'truncate'),
      drop: countOf(decisions, 'drop'),
      pinned: countOf(decisions, 'pinned'),
    },
    reduction: reductionOf(outcome),
    requests: outcome.requests,
    stateTokens: outcome.stateTokens,
    ...(outcome.stage === undefined ? {} : { stage: outcome.stage }),
    ...(reported.inputTokens === undefined
      ? {}
      : { inputTokens: reported.inputTokens }),
    ...(reported.cost === undefined ? {} : { cost: reported.cost }),
    ...(askedBytes === undefined ? {} : { askedBytesHeld: askedBytes.isHeld }),
    ...(reported.models === undefined
      ? {}
      : { models: [...reported.models] }),
    calls: decisions.map(({ call, action, keepCall, keepResult }) => {
      const accepted = expected[call.toolUseId]

      return {
        id: call.id,
        toolUseId: call.toolUseId,
        action,
        keepCall,
        keepResult,
        ...(accepted === undefined || action === 'pinned'
          ? {}
          : { expected: [...accepted] }),
      }
    }),
  }
}

/**
 * The figures of one route across its runs.
 */
export type RouteSummary = {
  route: Route
  routeLabel: string
  runs: number
  failed: number
  /** The median wall-clock of the runs that succeeded. */
  medianMs?: number
  /** The mean agreement of the runs that succeeded. */
  agreement?: number
  harmfulDrops?: number
  missedReductions?: number
  /** The mean reduction of the runs that succeeded. */
  reduction?: number
  requests?: number
  /** Summed over the runs whose provider counted them. */
  inputTokens?: number
  /** Summed over the runs whose provider reported it. */
  cost?: number
  /**
   * The share of judged calls whose action was the same in every repeat;
   * only present when some scenario has more than one successful repeat.
   */
  consistency?: number
  models?: string[]
  /**
   * True when the route's mean agreement on each unambiguous scenario
   * ('all-needed', 'retry') it ran is within 0.4 to 0.6 while its other
   * scenarios, if it ran any, did not all fail: answers that read as
   * present but meaningless, which no reply check catches.
   */
  suspect: boolean
  stages?: string[]
}

/**
 * The median of some numbers.
 *
 * @returns the middle value, or the mean of the two middle values; nothing
 * for no values
 */
export function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined
  }

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1
    ? sorted[middle]
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

function meanOf(values: readonly number[]): number | undefined {
  return values.length === 0
    ? undefined
    : values.reduce((sum, value) => sum + value, 0) / values.length
}

function sumOf(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter(value => value !== undefined)

  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0)
}

function distinctOf(values: readonly (readonly string[])[]): string[] {
  return [...new Set(values.flat())]
}

/**
 * The share of judged calls whose action was the same in every successful
 * repeat of a scenario, over the scenarios repeated more than once. A call
 * missing from one of the repeats counts as having changed.
 */
function consistencyOf(ok: readonly RunRecord[]): number | undefined {
  const byScenario = new Map<string, RunRecord[]>()

  for (const record of ok) {
    byScenario.set(record.scenario, [
      ...(byScenario.get(record.scenario) ?? []),
      record,
    ])
  }

  let calls = 0
  let same = 0

  for (const repeats of byScenario.values()) {
    if (repeats.length < 2) {
      continue
    }

    const actions = new Map<string, (Action | undefined)[]>()

    repeats.forEach((record, index) => {
      for (const call of record.calls ?? []) {
        if (call.action === 'pinned') {
          continue
        }

        const seen =
          actions.get(call.toolUseId) ??
          Array.from<Action | undefined>({ length: repeats.length })

        seen[index] = call.action
        actions.set(call.toolUseId, seen)
      }
    })

    for (const seen of actions.values()) {
      calls++

      if (seen.every(action => action !== undefined && action === seen[0])) {
        same++
      }
    }
  }

  return calls === 0 ? undefined : same / calls
}

/**
 * Whether a route answers the unambiguous scenarios near chance. Each of
 * them that has a successful run must be within the band; the route's
 * other scenarios, when it ran any, must not all have failed, since a route
 * that fails everywhere else is a failure rather than a suspect.
 */
function isSuspect(records: readonly RunRecord[]): boolean {
  const unambiguous = UNAMBIGUOUS_SCENARIOS.flatMap(scenario => {
    const agreement = meanOf(
      records
        .filter(record => record.ok && record.scenario === scenario)
        .flatMap(record =>
          record.agreement === undefined ? [] : [record.agreement],
        ),
    )

    return agreement === undefined ? [] : [agreement]
  })
  const others = records.filter(
    record => !UNAMBIGUOUS_SCENARIOS.includes(record.scenario),
  )

  return (
    unambiguous.length > 0 &&
    unambiguous.every(
      agreement => agreement >= SUSPECT_LOW && agreement <= SUSPECT_HIGH,
    ) &&
    (others.length === 0 || others.some(record => record.ok))
  )
}

function summaryOf(records: readonly RunRecord[]): RouteSummary {
  const [first] = records as [RunRecord, ...RunRecord[]]
  const ok = records.filter(record => record.ok)
  const summary: RouteSummary = {
    route: first.route,
    routeLabel: first.routeLabel,
    runs: records.length,
    failed: records.length - ok.length,
    suspect: isSuspect(records),
  }
  const figures = {
    medianMs: medianOf(ok.map(record => record.ms)),
    agreement: meanOf(
      ok.flatMap(record =>
        record.agreement === undefined ? [] : [record.agreement],
      ),
    ),
    harmfulDrops: sumOf(ok.map(record => record.harmfulDrops)),
    missedReductions: sumOf(ok.map(record => record.missedReductions)),
    reduction: meanOf(
      ok.flatMap(record =>
        record.reduction === undefined ? [] : [record.reduction],
      ),
    ),
    requests: sumOf(ok.map(record => record.requests)),
    inputTokens: sumOf(ok.map(record => record.inputTokens)),
    cost: sumOf(ok.map(record => record.cost)),
    consistency: consistencyOf(ok),
  }

  for (const [key, value] of Object.entries(figures)) {
    if (value !== undefined) {
      Object.assign(summary, { [key]: value })
    }
  }

  const models = distinctOf(ok.map(record => record.models ?? []))
  const stages = distinctOf(
    ok.map(record => (record.stage === undefined ? [] : [record.stage])),
  )

  if (models.length > 0) {
    summary.models = models
  }

  if (stages.length > 0) {
    summary.stages = stages
  }

  return summary
}

/**
 * A labelled call whose action no route that ran it accepted.
 */
export type Disputed = {
  scenario: string
  toolUseId: string
  expected: readonly Action[]
  /**
   * What each route did with the call, by its label; the distinct actions
   * of its repeats joined with `/` when they differ.
   */
  actions: Record<string, string>
}

/**
 * The labelled calls on which every route that ran them disagrees with the
 * label. When every model judges a call the other way, the label is more
 * likely wrong than every model, and a wrong label lowers every route's
 * agreement alike; listing these calls lets the label be checked by hand
 * instead of being read as model noise. Only successful runs count, and a
 * route that agrees in any of its repeats keeps the call off the list.
 *
 * @param records every run's record
 * @returns the disputed calls, by scenario in the order the records first
 * name it, then in the order of the calls
 */
export function disputedOf(records: readonly RunRecord[]): Disputed[] {
  const byCall = new Map<
    string,
    { disputed: Disputed; seen: Map<string, Action[]>; isAccepted: boolean }
  >()

  for (const record of records) {
    if (!record.ok) {
      continue
    }

    for (const call of record.calls ?? []) {
      if (call.expected === undefined) {
        continue
      }

      const key = `${record.scenario}\u0000${call.toolUseId}`
      const entry = byCall.get(key) ?? {
        disputed: {
          scenario: record.scenario,
          toolUseId: call.toolUseId,
          expected: call.expected,
          actions: {},
        },
        seen: new Map<string, Action[]>(),
        isAccepted: false,
      }
      const actions = entry.seen.get(record.routeLabel) ?? []

      if (!actions.includes(call.action)) {
        actions.push(call.action)
      }

      entry.seen.set(record.routeLabel, actions)
      entry.isAccepted ||= call.expected.includes(call.action)
      byCall.set(key, entry)
    }
  }

  return [...byCall.values()]
    .filter(entry => !entry.isAccepted)
    .map(({ disputed, seen }) => ({
      ...disputed,
      actions: Object.fromEntries(
        [...seen].map(([label, actions]) => [label, actions.join('/')]),
      ),
    }))
}

/**
 * The figures of each route across its runs.
 *
 * @param records every run's record
 * @returns one summary per distinct provider and model, in the order the
 * routes first appear
 */
export function summariesOf(records: readonly RunRecord[]): RouteSummary[] {
  const byRoute: RunRecord[][] = []

  for (const record of records) {
    const group = byRoute.find(
      ([first]) =>
        first?.route.provider === record.route.provider &&
        first.route.model === record.route.model,
    )

    if (group === undefined) {
      byRoute.push([record])
    } else {
      group.push(record)
    }
  }

  return byRoute.map(summaryOf)
}
