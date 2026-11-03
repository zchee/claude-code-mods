import { percentOf } from '../hooks/report'
import type { Disputed, RouteSummary, RunRecord } from './metrics'

/**
 * What every report closes with, so that no figure is read as a verdict on
 * a model in isolation.
 */
export const CAVEAT: string =
  'These figures compare routes as the mod drives them, each with its own ' +
  'question cap, wire format, byte cap and cut stage, not the raw quality ' +
  'of the models on identical input: a route whose state was cut judged ' +
  'less of the conversation than one that took it whole. Jev through ' +
  'OpenRouter and the OpenRouter-only routes share the 27,200-token state ' +
  'cap, but Jev through OpenRouter is also held to the byte cap it asks ' +
  'for, so on a large conversation it sees a smaller state than the ' +
  'OpenRouter-only models at the same token cap; and an OpenRouter-only ' +
  'model whose stated window is smaller than that cap is held to its ' +
  'window.'

/**
 * What a cell holds when there is no figure for it.
 */
const NONE = '-'

/**
 * What stands between two columns.
 */
const GAP = '  '

type Column<Row> = {
  title: string
  /** Figures are right-aligned so their digits line up. */
  isFigure: boolean
  cell: (row: Row) => string
}

function percentOrNone(ratio: number | undefined): string {
  return ratio === undefined ? NONE : percentOf(ratio)
}

function figureOrNone(value: number | undefined): string {
  return value === undefined ? NONE : String(Math.round(value))
}

function probabilityOrNone(probability: number | undefined): string {
  return probability === undefined ? NONE : probability.toFixed(2)
}

function costOrNone(cost: number | undefined): string {
  return cost === undefined ? NONE : `$${cost.toFixed(6)}`
}

function heldOrNone(isHeld: boolean | undefined): string {
  return isHeld === undefined ? NONE : isHeld ? 'yes' : 'no'
}

function modelsOrNone(models: readonly string[] | undefined): string {
  return models === undefined || models.length === 0
    ? NONE
    : models.join(', ')
}

/**
 * Lays rows out in columns padded to their widest cell. The last column is
 * left unpadded, so no line ends in spaces.
 */
function tableOf<Row>(
  columns: readonly Column<Row>[],
  rows: readonly Row[],
): string {
  const lines = [
    columns.map(column => column.title),
    ...rows.map(row => columns.map(column => column.cell(row))),
  ]
  const widths = columns.map((_, index) =>
    Math.max(...lines.map(line => (line[index] as string).length)),
  )
  const laidOut = (line: readonly string[]) =>
    line
      .map((cell, index) => {
        if (index === line.length - 1) {
          return cell
        }

        const width = widths[index] as number

        return columns[index]?.isFigure === true
          ? cell.padStart(width)
          : cell.padEnd(width)
      })
      .join(GAP)
      .trimEnd()
  const [header, ...body] = lines as [string[], ...string[][]]

  return [
    laidOut(header),
    widths.map(width => '-'.repeat(width)).join(GAP),
    ...body.map(laidOut),
  ].join('\n')
}

/**
 * The runs of one scenario, one row each. A failed run shows its reason in
 * the last column and no figure but its wall-clock.
 *
 * @param scenario the scenario to show; records of other scenarios are left
 * out
 * @param records the records of the runs
 * @returns the table, its first line naming the scenario
 */
export function scenarioTableOf(
  scenario: string,
  records: readonly RunRecord[],
): string {
  const rows = records.filter(record => record.scenario === scenario)
  const isRepeated = new Set(rows.map(record => record.repeat)).size > 1
  const ifOk =
    (cell: (record: RunRecord) => string) => (record: RunRecord) =>
      record.ok ? cell(record) : NONE
  const columns: Column<RunRecord>[] = [
    {
      title: 'route',
      isFigure: false,
      cell: record =>
        isRepeated
          ? `${record.routeLabel} #${record.repeat}`
          : record.routeLabel,
    },
    {
      title: 'ok/FAIL',
      isFigure: false,
      cell: record => (record.ok ? 'ok' : 'FAIL'),
    },
    {
      title: 'requests',
      isFigure: true,
      cell: ifOk(record => figureOrNone(record.requests)),
    },
    { title: 'ms', isFigure: true, cell: record => figureOrNone(record.ms) },
    {
      title: 'stage',
      isFigure: false,
      cell: ifOk(record => record.stage ?? NONE),
    },
    {
      title: 'state tokens',
      isFigure: true,
      cell: ifOk(record => figureOrNone(record.stateTokens)),
    },
    {
      title: 'asked bytes held',
      isFigure: false,
      cell: ifOk(record => heldOrNone(record.askedBytesHeld)),
    },
    {
      title: 'reduction',
      isFigure: true,
      cell: ifOk(record => percentOrNone(record.reduction)),
    },
    {
      title: 'kept/cut/dropped',
      isFigure: true,
      cell: ifOk(record =>
        record.counts === undefined
          ? NONE
          : `${record.counts.keep}/${record.counts.truncate}/${record.counts.drop}`,
      ),
    },
    {
      title: 'agreement',
      isFigure: true,
      cell: ifOk(record => percentOrNone(record.agreement)),
    },
    {
      title: 'harmful',
      isFigure: true,
      cell: ifOk(record => figureOrNone(record.harmfulDrops)),
    },
    {
      title: 'lossy',
      isFigure: true,
      cell: ifOk(record => figureOrNone(record.lossyCuts)),
    },
    {
      title: 'tokens counted',
      isFigure: true,
      cell: ifOk(record => figureOrNone(record.inputTokens)),
    },
    {
      title: 'cost',
      isFigure: true,
      cell: ifOk(record => costOrNone(record.cost)),
    },
    {
      title: 'answered as',
      isFigure: false,
      cell: record =>
        record.ok
          ? modelsOrNone(record.models)
          : (record.failure ?? NONE).replace(/\s+/g, ' ').trim(),
    },
  ]

  return `scenario ${scenario}\n${tableOf(columns, rows)}`
}

/**
 * Every route across its runs, one row each.
 *
 * @param summaries the summaries, in the order they are to be shown
 * @returns the table
 */
export function summaryTableOf(summaries: readonly RouteSummary[]): string {
  const columns: Column<RouteSummary>[] = [
    { title: 'route', isFigure: false, cell: summary => summary.routeLabel },
    { title: 'runs', isFigure: true, cell: summary => String(summary.runs) },
    {
      title: 'failed',
      isFigure: true,
      cell: summary => String(summary.failed),
    },
    {
      title: 'median ms',
      isFigure: true,
      cell: summary => figureOrNone(summary.medianMs),
    },
    {
      title: 'stages',
      isFigure: false,
      cell: summary =>
        summary.stages === undefined || summary.stages.length === 0
          ? NONE
          : summary.stages.join('/'),
    },
    {
      title: 'agreement',
      isFigure: true,
      cell: summary => percentOrNone(summary.agreement),
    },
    {
      title: 'harmful',
      isFigure: true,
      cell: summary => figureOrNone(summary.harmfulDrops),
    },
    {
      title: 'lossy',
      isFigure: true,
      cell: summary => figureOrNone(summary.lossyCuts),
    },
    {
      title: 'missed',
      isFigure: true,
      cell: summary => figureOrNone(summary.missedReductions),
    },
    {
      title: 'keep P(call)',
      isFigure: true,
      cell: summary => probabilityOrNone(summary.keepLabelled?.medianCall),
    },
    {
      title: 'keep P(result)',
      isFigure: true,
      cell: summary => probabilityOrNone(summary.keepLabelled?.medianResult),
    },
    {
      title: 'reduction',
      isFigure: true,
      cell: summary => percentOrNone(summary.reduction),
    },
    {
      title: 'requests',
      isFigure: true,
      cell: summary => figureOrNone(summary.requests),
    },
    {
      title: 'tokens',
      isFigure: true,
      cell: summary => figureOrNone(summary.inputTokens),
    },
    {
      title: 'cost',
      isFigure: true,
      cell: summary => costOrNone(summary.cost),
    },
    {
      title: 'consistency',
      isFigure: true,
      cell: summary => percentOrNone(summary.consistency),
    },
    {
      title: 'suspect',
      isFigure: false,
      cell: summary => (summary.suspect ? 'suspect' : NONE),
    },
    {
      title: 'degenerate',
      isFigure: false,
      cell: summary => summary.degenerate ?? NONE,
    },
    {
      title: 'answered as',
      isFigure: false,
      cell: summary => modelsOrNone(summary.models),
    },
  ]

  return tableOf(columns, summaries)
}

/**
 * The calls most routes disagreed with the label on, one line each with
 * the routes that agreed, so a label that is more likely wrong than most
 * models is checked by hand.
 *
 * @param disputed the calls, as `disputedOf` lists them
 * @returns the lines, or one line saying that no call is disputed
 */
export function disputedLinesOf(disputed: readonly Disputed[]): string {
  if (disputed.length === 0) {
    return 'no call disputed by most routes'
  }

  return disputed
    .map(
      call =>
        `disputed ${call.scenario} ${call.toolUseId}: labelled ` +
        `${call.expected.join('/')}, answered ` +
        Object.entries(call.actions)
          .map(([route, actions]) => `${actions} by ${route}`)
          .join(', ') +
        '; agreed by: ' +
        (call.agreeing.length === 0 ? 'none' : call.agreeing.join(', ')),
    )
    .join('\n')
}
