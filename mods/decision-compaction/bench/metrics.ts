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
 * The judged calls the reference says to keep whole and nothing else: how
 * many there are, and the median of each probability over them. A low
 * median P(result) on these calls is what a state that tells the model too
 * little about a result shows.
 */
export type KeepLabelled = {
  count: number
  medianCall: number
  medianResult: number
}

/**
 * The figures of one run. The scores against the reference (`agreement`,
 * `harmfulDrops`, `lossyCuts`, `missedReductions`, `unlabelled`, `sweep`)
 * are recomputed from the recorded probabilities at the threshold asked
 * for; `counts`, `reduction` and the actions in `calls` are what the mod in
 * fact did. The two agree when the threshold asked for is the one the run
 * was configured with.
 *
 * A record with `lossyCuts` has `harmfulDrops` counting removed calls only.
 * One without it was written before the two were told apart, and its
 * `harmfulDrops` counts cut and removed calls together.
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
  /** Calls the reference says to keep whole that were removed. */
  harmfulDrops?: number
  /**
   * Calls the reference says to keep whole whose result was cut to its
   * head: the call stays and the rest of the result can be read again, so
   * it costs less than a removal.
   */
  lossyCuts?: number
  /** Calls the reference says to cut or remove that were kept whole. */
  missedReductions?: number
  /** Judged calls the reference has no label for; they count as disagreeing. */
  unlabelled?: number
  /** Absent when no judged call is labelled `keep` alone. */
  keepLabelled?: KeepLabelled
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
  lossyCuts: number
  missedReductions: number
  unlabelled: number
}

/**
 * One judged call as it is scored: the action taken, and the actions the
 * reference accepts, if it has a label for the call.
 */
type Judged = { action: Action; accepted?: readonly Action[] }

function isKeepOnly(accepted: readonly Action[] | undefined): boolean {
  return accepted?.length === 1 && accepted[0] === 'keep'
}

/**
 * Scores judged calls against the reference. A call with no label counts
 * as judged and disagreeing, and as neither harmful nor missed.
 */
function scoredOf(judged: readonly Judged[]): Scored {
  let agreed = 0
  let harmfulDrops = 0
  let lossyCuts = 0
  let missedReductions = 0
  let unlabelled = 0

  for (const { action, accepted } of judged) {
    if (accepted === undefined) {
      unlabelled++
      continue
    }

    if (accepted.includes(action)) {
      agreed++
    }

    if (isKeepOnly(accepted)) {
      if (action === 'drop') {
        harmfulDrops++
      } else if (action === 'truncate') {
        lossyCuts++
      }
    }

    if (!accepted.includes('keep') && action === 'keep') {
      missedReductions++
    }
  }

  return {
    ...(judged.length === 0 ? {} : { agreement: agreed / judged.length }),
    harmfulDrops,
    lossyCuts,
    missedReductions,
    unlabelled,
  }
}

function scoredAt(
  judged: readonly Decision[],
  expected: Expected,
  threshold: number,
): Scored {
  return scoredOf(
    judged.map(decision => {
      const { action } = decide(
        decision.call,
        { keepCall: decision.keepCall, keepResult: decision.keepResult },
        threshold,
      )
      const accepted = expected[decision.call.toolUseId]

      return accepted === undefined ? { action } : { action, accepted }
    }),
  )
}

/**
 * The keep-only figures of some calls; pinned calls and calls with any
 * other label are left out.
 *
 * @returns nothing when none of the calls is labelled `keep` alone
 */
function keepLabelledOf(
  calls: readonly CallRecord[],
): KeepLabelled | undefined {
  const kept = calls.filter(
    call => call.action !== 'pinned' && isKeepOnly(call.expected),
  )
  const medianCall = medianOf(kept.map(call => call.keepCall))
  const medianResult = medianOf(kept.map(call => call.keepResult))

  return medianCall === undefined || medianResult === undefined
    ? undefined
    : { count: kept.length, medianCall, medianResult }
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

  const calls = decisions.map(({ call, action, keepCall, keepResult }) => {
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
  })
  const keepLabelled = keepLabelledOf(calls)

  return {
    ...base,
    ok: true,
    judged: judged.length,
    ...scored,
    ...(keepLabelled === undefined ? {} : { keepLabelled }),
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
    calls,
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
  /** Summed as `RunRecord.harmfulDrops`: keep-only calls that were removed. */
  harmfulDrops?: number
  /** Summed as `RunRecord.lossyCuts`: keep-only calls that were cut. */
  lossyCuts?: number
  missedReductions?: number
  /**
   * Over the keep-only calls of every run that succeeded, pooled: the
   * medians are of those calls, not of each run's medians.
   */
  keepLabelled?: KeepLabelled
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
  /**
   * Set when the route kept none (`keeps nothing`) or all (`keeps
   * everything`) of the calls it judged across its successful runs, by the
   * actions the mod took at the configured threshold. A call that was cut
   * is not kept, so a route that cuts every call keeps nothing. Absent when
   * the route judged no call.
   */
  degenerate?: 'keeps nothing' | 'keeps everything'
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

/**
 * Whether a route kept none or all of the calls it judged, over the
 * successful runs that counted their actions.
 */
function degenerateOf(
  ok: readonly RunRecord[],
): RouteSummary['degenerate'] | undefined {
  let judged = 0
  let kept = 0

  for (const record of ok) {
    if (record.counts !== undefined) {
      judged += record.judged
      kept += record.counts.keep
    }
  }

  if (judged === 0) {
    return undefined
  }

  return kept === 0
    ? 'keeps nothing'
    : kept === judged
      ? 'keeps everything'
      : undefined
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
  const degenerate = degenerateOf(ok)

  if (degenerate !== undefined) {
    summary.degenerate = degenerate
  }
  const figures = {
    medianMs: medianOf(ok.map(record => record.ms)),
    agreement: meanOf(
      ok.flatMap(record =>
        record.agreement === undefined ? [] : [record.agreement],
      ),
    ),
    harmfulDrops: sumOf(ok.map(record => record.harmfulDrops)),
    lossyCuts: sumOf(ok.map(record => record.lossyCuts)),
    missedReductions: sumOf(ok.map(record => record.missedReductions)),
    keepLabelled: keepLabelledOf(ok.flatMap(record => record.calls ?? [])),
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
 * A labelled call whose action most routes that ran it did not accept.
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
  /**
   * The routes that agreed with the label in at least one repeat, by their
   * label, in the order the records first name them.
   */
  agreeing: string[]
}

/**
 * The labelled calls on which more than half of the routes that ran them
 * disagree with the label. When most models judge a call the other way, the
 * label is more likely wrong than they are, and a wrong label lowers every
 * route's agreement alike; listing these calls, with the routes that did
 * agree, lets the label be checked by hand instead of being read as model
 * noise. A rule of every route would let one route that keeps everything
 * hide every `keep` label. Only successful runs count, and a route agrees
 * when it agrees in any of its repeats. Half or fewer is not a majority, so
 * a call one of two routes disagrees with is not listed.
 *
 * @param records every run's record
 * @returns the disputed calls, by scenario in the order the records first
 * name it, then in the order of the calls
 */
export function disputedOf(records: readonly RunRecord[]): Disputed[] {
  const byCall = new Map<
    string,
    {
      disputed: Omit<Disputed, 'agreeing'>
      seen: Map<string, Action[]>
      agreeing: Set<string>
    }
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
        agreeing: new Set<string>(),
      }
      const actions = entry.seen.get(record.routeLabel) ?? []

      if (!actions.includes(call.action)) {
        actions.push(call.action)
      }

      entry.seen.set(record.routeLabel, actions)

      if (call.expected.includes(call.action)) {
        entry.agreeing.add(record.routeLabel)
      }

      byCall.set(key, entry)
    }
  }

  return [...byCall.values()]
    .filter(({ seen, agreeing }) => seen.size - agreeing.size > seen.size / 2)
    .map(({ disputed, seen, agreeing }) => ({
      ...disputed,
      actions: Object.fromEntries(
        [...seen].map(([label, actions]) => [label, actions.join('/')]),
      ),
      // In the order the routes were first seen on the call, not the order
      // their agreeing repeat came in.
      agreeing: [...seen.keys()].filter(label => agreeing.has(label)),
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

/**
 * The scores of one run as the recorded calls give them back.
 */
export type Recounted = {
  routeLabel: string
  scenario: string
  repeat: number
  judged: number
  agreement?: number
  harmfulDrops: number
  lossyCuts: number
  missedReductions: number
  unlabelled: number
  keepLabelled?: KeepLabelled
}

/**
 * The recounted scores summed over the runs; `keepLabelled` pools their
 * calls.
 */
export type RecountTotals = {
  records: number
  judged: number
  harmfulDrops: number
  lossyCuts: number
  missedReductions: number
  unlabelled: number
  keepLabelled?: KeepLabelled
}

/**
 * The scores of saved runs recounted from the action and the label written
 * for each call, with no request and no threshold: a saved JSON's figures
 * can be read again with the split between removed and cut calls, also
 * from a file written before that split, whose `harmfulDrops` is then
 * `harmfulDrops + lossyCuts` of the recount. Judged calls are those not
 * pinned, as `RunRecord.judged` counts them, and a judged call with no
 * label counts as disagreeing, so `agreement` and `missedReductions` come
 * out as the record has them when the record was scored at the threshold
 * its actions were decided with. `recordOf` can score a run at another
 * threshold while writing the actions the run took, and the recount of
 * such a record follows the actions, not its scores.
 *
 * @param records the saved records; failed runs, and successful ones that
 * carry no calls, are left out, since they have nothing to recount
 * @returns one entry per recounted run, in the order given, and the totals
 */
export function recountOf(records: readonly RunRecord[]): {
  records: Recounted[]
  totals: RecountTotals
} {
  const recounted: Recounted[] = []
  const pooled: CallRecord[] = []

  for (const record of records) {
    if (!record.ok || record.calls === undefined) {
      continue
    }

    const judged = record.calls.filter(call => call.action !== 'pinned')
    const keepLabelled = keepLabelledOf(judged)

    pooled.push(...judged)
    recounted.push({
      routeLabel: record.routeLabel,
      scenario: record.scenario,
      repeat: record.repeat,
      judged: judged.length,
      ...scoredOf(
        judged.map(({ action, expected }) =>
          expected === undefined ? { action } : { action, accepted: expected },
        ),
      ),
      ...(keepLabelled === undefined ? {} : { keepLabelled }),
    })
  }

  const total = (
    key:
      | 'judged'
      | 'harmfulDrops'
      | 'lossyCuts'
      | 'missedReductions'
      | 'unlabelled',
  ) => recounted.reduce((sum, entry) => sum + entry[key], 0)
  const keepLabelled = keepLabelledOf(pooled)

  return {
    records: recounted,
    totals: {
      records: recounted.length,
      judged: total('judged'),
      harmfulDrops: total('harmfulDrops'),
      lossyCuts: total('lossyCuts'),
      missedReductions: total('missedReductions'),
      unlabelled: total('unlabelled'),
      ...(keepLabelled === undefined ? {} : { keepLabelled }),
    },
  }
}
