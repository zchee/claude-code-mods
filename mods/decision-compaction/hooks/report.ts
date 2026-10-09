import { reductionOf } from './compact'
import type { Action, Decision } from './compact'
import { labelOf } from './route'
import type { Result } from './run'

/**
 * The longest line `$.ui.log` is given; a longer decisions list is split.
 */
const LOG_LINE_CHARS = 4096

/**
 * What every line of the per-call verdicts starts with.
 */
const VERDICTS = 'per-call verdicts'

/**
 * Room kept in every line for the lead, the longest of which is
 * `per-call verdicts, part 12 of 34: `.
 */
const LEAD_ROOM = 40

/**
 * What stands between two entries on a line.
 */
const BETWEEN = '; '

/**
 * A ratio as a whole percentage.
 *
 * @param ratio the ratio, 0 to 1
 * @returns for example `42%`
 */
export function percentOf(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function countOf(decisions: readonly Decision[], action: Action): number {
  return decisions.filter(decision => decision.action === action).length
}

/**
 * One line saying what a compaction did and what it cost to decide.
 *
 * It names the provider and model that answered, and puts the state's
 * estimated size beside the input tokens the provider itself counted. The
 * two disagreeing shows how far the estimate drifts; the provider's count
 * falling well below the estimate shows a state the provider cut short.
 *
 * The calls are counted by what happened to them, not by what was decided:
 * a call whose result was to be cut, but was too short to gain from it,
 * stands whole and is counted so.
 *
 * @param result the compaction
 * @returns the line, without a lead
 */
export function summaryOf(result: Result): string {
  const { outcome, route } = result
  const uncut = countOf(outcome.decisions, 'truncate') - outcome.shortened
  const counts = (
    [
      ['left whole', countOf(outcome.decisions, 'keep') + uncut],
      ['with the result cut short', outcome.shortened],
      ['removed', countOf(outcome.decisions, 'drop')],
      ['not judged', countOf(outcome.decisions, 'pinned')],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([said, count]) => `${count} ${said}`)
  const parts = [
    `${percentOf(reductionOf(outcome))} smaller`,
    counts.length > 0
      ? `tool calls: ${counts.join(', ')}`
      : 'no answered tool call',
  ]

  if (outcome.requests > 0) {
    const counted =
      outcome.reported.inputTokens === undefined
        ? ''
        : `, ${outcome.reported.inputTokens} input tokens counted by the provider`
    const cost =
      outcome.reported.cost === undefined
        ? ''
        : `, cost $${outcome.reported.cost.toFixed(6)}`

    parts.push(
      `${labelOf(route)} in ${outcome.requests} ` +
        `${outcome.requests === 1 ? 'request' : 'requests'}`,
      `state about ${outcome.stateTokens} tokens estimated ` +
        `(${outcome.stage ?? 'whole'})${counted}${cost}`,
    )
  }

  return parts.join('; ')
}

/**
 * The decisions as log lines: one entry per call that was asked about, with
 * both probabilities, split so that no line exceeds what one log line holds.
 *
 * @param decisions every decision of the compaction
 * @param maxChars the longest a line may be
 * @returns the lines, in call order
 */
export function decisionLinesOf(
  decisions: readonly Decision[],
  maxChars: number = LOG_LINE_CHARS,
): string[] {
  const entries = decisions
    .filter(decision => decision.action !== 'pinned')
    .map(
      ({ call, action, keepCall, keepResult }) =>
        `${call.id} ${call.tool} -> ${action} ` +
        `(call ${keepCall.toFixed(2)}, result ${keepResult.toFixed(2)})`,
    )

  // Each line is a group of entries, filled by length: an entry joins the
  // newest group while the group, with it and the separator before it,
  // stays within the room, and opens a group of its own otherwise. An entry
  // longer than the room therefore still gets a line.
  const room = Math.max(1, maxChars - LEAD_ROOM)
  const groups: string[][] = []
  let used = 0

  for (const entry of entries) {
    const newest = groups.at(-1)
    const added = BETWEEN.length + entry.length

    if (newest === undefined || used + added > room) {
      groups.push([entry])
      used = entry.length
    } else {
      newest.push(entry)
      used += added
    }
  }

  if (groups.length === 0) {
    return [`${VERDICTS}: no tool call was asked about`]
  }

  return groups.map((group, index) => {
    const lead =
      groups.length === 1
        ? VERDICTS
        : `${VERDICTS}, part ${index + 1} of ${groups.length}`

    return `${lead}: ${group.join(BETWEEN)}`
  })
}
