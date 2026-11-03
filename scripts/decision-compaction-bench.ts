// Runs the same invented conversations through every decision model the
// decision-compaction mod can reach whose credentials are set in the
// environment, through the mod's own `run()`, one compaction at a time, and
// prints how each route's decisions compare with the labels the corpus
// carries, with the time, the requests, the tokens and the cost of each.
//
// Usage: bun scripts/decision-compaction-bench.ts [flags]; see USAGE.
// Exit status: 1 when any real run or the bench itself failed, 2 on a usage
// error, 130 after an interrupt, 0 otherwise.
import { writeFileSync } from 'node:fs'

import type { HttpInit, HttpResponse } from 'claude-code'

import {
  PRESERVE_RECENT,
  SCENARIOS,
  scenarioOf,
} from '../mods/decision-compaction/bench/corpus'
import type { Scenario } from '../mods/decision-compaction/bench/corpus'
import {
  disputedOf,
  recordOf,
  summariesOf,
} from '../mods/decision-compaction/bench/metrics'
import type {
  RouteSummary,
  Run,
  RunRecord,
} from '../mods/decision-compaction/bench/metrics'
import {
  budgetOverrideOf,
  CATALOG_FETCHED_AT,
  OPENROUTER_CATALOG,
  openrouterOnlyOf,
} from '../mods/decision-compaction/bench/openrouter-catalog'
import type { CatalogEntry } from '../mods/decision-compaction/bench/openrouter-catalog'
import {
  CAVEAT,
  disputedLinesOf,
  scenarioTableOf,
  summaryTableOf,
} from '../mods/decision-compaction/bench/table'
import {
  WORDINGS,
  wordingOf,
} from '../mods/decision-compaction/bench/wordings'
import type { Wording } from '../mods/decision-compaction/bench/wordings'
import type { Ports } from '../mods/decision-compaction/hooks/ask'
import { configOf } from '../mods/decision-compaction/hooks/config'
import type { Config } from '../mods/decision-compaction/hooks/config'
import {
  credentialsFor,
  credentialsOf,
  messageOf,
  missingOf,
  modelsOf,
  providerOf,
  PROVIDERS,
  redacted,
  routeOf,
  wireOf,
} from '../mods/decision-compaction/hooks/providers'
import type {
  Credentials,
  Environment,
  ProviderName,
  Route,
} from '../mods/decision-compaction/hooks/providers'
import { run } from '../mods/decision-compaction/hooks/run'
import type { Job, Result } from '../mods/decision-compaction/hooks/run'
import {
  estimatedTokensOf,
  goalOf,
  pairCalls,
  RESULT_HEAD_MAX,
  stateWithin,
} from '../mods/decision-compaction/hooks/state'
import { bytesOf } from '../mods/decision-compaction/hooks/systemone'

export const USAGE = `usage: bun scripts/decision-compaction-bench.ts [flags]

  --provider <name>        only this provider; repeatable (${PROVIDERS.join(', ')})
  --model <name>           only this model; needs exactly one --provider
  --scenario <id>          only this scenario; repeatable
  --repeat <n>             compactions per route and scenario (default 1)
  --questions <name>       the wording asked in (default current, the mod's own):
                           ${WORDINGS.map(wording => wording.name).join(', ')}
  --state none|head:<n>    what the state shows of each call's output: nothing
                           (none, the default, the mod's own) or its first n
                           characters, n from 1 to ${RESULT_HEAD_MAX} (head:<n>, only with
                           --questions current)
  --dry-run                build each route's first request and send nothing
  --out <path>             also write a JSON record of every run (not with --dry-run)
  --openrouter-catalog static|live|off
                           the OpenRouter-only models: the table in the mod
                           (static, the default), OpenRouter's listing fetched
                           now (live), or none (off)
  --help                   print this and exit`

/**
 * The OpenRouter listing of the models whose output is a decision.
 */
export const OPENROUTER_LISTING_URL =
  'https://openrouter.ai/api/v1/models?output_modalities=decisions'

export type CatalogMode = 'static' | 'live' | 'off'

export type Flags = {
  providers: ProviderName[]
  model?: string
  scenarios: string[]
  repeat: number
  /**
   * The name of the wording the questions and the state's context are
   * asked in; `current` is the mod's own.
   */
  questions: string
  /**
   * What the state shows of each call's output: `none`, as a compaction
   * sends it, or `head:<n>`, its first n characters.
   */
  state: string
  dryRun: boolean
  out?: string
  catalog: CatalogMode
  help: boolean
}

/**
 * A mistake in the command line: the entry prints it with the usage and
 * exits 2.
 */
export class UsageError extends Error {}

/**
 * The characters of each output a `--state` value shows.
 *
 * @param state `none` or `head:<n>`
 * @returns 0 for `none`, n for `head:<n>` with n from 1 to
 * `RESULT_HEAD_MAX`, undefined for anything else
 */
export function resultHeadOf(state: string): number | undefined {
  if (state === 'none') {
    return 0
  }

  const count = /^head:(\d+)$/.exec(state)?.[1]
  const head = Number(count)

  return count !== undefined &&
    Number.isSafeInteger(head) &&
    head >= 1 &&
    head <= RESULT_HEAD_MAX
    ? head
    : undefined
}

/**
 * What a dry run's `fetch` throws, before anything reaches a network.
 */
export class DryRunSentinel extends Error {
  constructor() {
    super('dry run: nothing is sent')
  }
}

/**
 * Reads the command line.
 *
 * @param argv the arguments after the script's path
 * @returns the flags; throws a `UsageError` naming the first mistake
 */
export function parseArgs(argv: readonly string[]): Flags {
  const flags: Flags = {
    providers: [],
    scenarios: [],
    repeat: 1,
    questions: 'current',
    state: 'none',
    dryRun: false,
    catalog: 'static',
    help: false,
  }
  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1]

    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} needs a value`)
    }

    return value
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string

    switch (arg) {
      case '--provider': {
        const value = valueAfter(index++, arg)
        const provider = providerOf(value)

        if (provider === undefined) {
          throw new UsageError(
            `--provider ${value} is none of ${PROVIDERS.join(', ')}`,
          )
        }

        if (!flags.providers.includes(provider)) {
          flags.providers.push(provider)
        }

        break
      }
      case '--model':
        flags.model = valueAfter(index++, arg).trim()
        break
      case '--scenario': {
        const value = valueAfter(index++, arg)

        if (scenarioOf(value) === undefined) {
          throw new UsageError(
            `--scenario ${value} is none of ` +
              SCENARIOS.map(scenario => scenario.id).join(', '),
          )
        }

        if (!flags.scenarios.includes(value)) {
          flags.scenarios.push(value)
        }

        break
      }
      case '--repeat': {
        const value = valueAfter(index++, arg)
        const repeat = Number(value)

        if (
          !/^\d+$/.test(value) ||
          !Number.isSafeInteger(repeat) ||
          repeat < 1
        ) {
          throw new UsageError(
            `--repeat ${value} is not a whole number of 1 or more`,
          )
        }

        flags.repeat = repeat
        break
      }
      case '--questions': {
        const value = valueAfter(index++, arg)

        if (wordingOf(value) === undefined) {
          throw new UsageError(
            `--questions ${value} is none of ` +
              WORDINGS.map(wording => wording.name).join(', '),
          )
        }

        flags.questions = value
        break
      }
      case '--state': {
        const value = valueAfter(index++, arg)

        if (resultHeadOf(value) === undefined) {
          throw new UsageError(
            `--state ${value} is neither none nor head:<n> with n a whole ` +
              `number from 1 to ${RESULT_HEAD_MAX}`,
          )
        }

        flags.state = value
        break
      }
      case '--dry-run':
        flags.dryRun = true
        break
      case '--out':
        flags.out = valueAfter(index++, arg)
        break
      case '--openrouter-catalog': {
        const value = valueAfter(index++, arg)

        if (value !== 'static' && value !== 'live' && value !== 'off') {
          throw new UsageError(
            `--openrouter-catalog ${value} is none of static, live, off`,
          )
        }

        flags.catalog = value
        break
      }
      case '--help':
      case '-h':
        flags.help = true
        break
      default:
        throw new UsageError(`unknown flag ${arg}`)
    }
  }

  if (flags.model !== undefined && flags.providers.length !== 1) {
    throw new UsageError('--model needs exactly one --provider')
  }

  if (flags.dryRun && flags.out !== undefined) {
    throw new UsageError('--out records real runs; a dry run has none')
  }

  if (flags.state !== 'none' && flags.questions !== 'current') {
    throw new UsageError(
      `--state ${flags.state} needs --questions current: the other ` +
        'wordings describe a state without result heads',
    )
  }

  return flags
}

/**
 * A route the bench may drive: the budget override a catalogue model whose
 * window is below the mod's default is held to, or why it is skipped.
 */
export type Planned = {
  route: Route
  override?: { maxStateTokens: number; maxRequestTokens: number }
  skip?: string
}

/**
 * Lists the routes to drive, in a fixed order: every provider in
 * `PROVIDERS` order with the models it offers, and for `openrouter` the
 * catalogue's models after its own. A route whose provider lacks a
 * credential is listed with the variables that are unset.
 *
 * @param flags the command line
 * @param credentials every credential resolved from the environment
 * @param catalog the OpenRouter-only models; empty with `off`
 * @returns the routes
 */
export function routesOf(
  flags: Pick<Flags, 'providers' | 'model' | 'catalog'>,
  credentials: Credentials,
  catalog: readonly CatalogEntry[],
): Planned[] {
  const catalogued = new Map(catalog.map(entry => [entry.id, entry]))
  const providers =
    flags.providers.length === 0
      ? PROVIDERS
      : PROVIDERS.filter(provider => flags.providers.includes(provider))
  const planned: Planned[] = []

  for (const provider of providers) {
    const models =
      flags.model !== undefined
        ? [flags.model]
        : [
            ...modelsOf(provider),
            ...(provider === 'openrouter' && flags.catalog !== 'off'
              ? catalog.map(entry => entry.id)
              : []),
          ]
    const missing = missingOf(provider, credentials)

    for (const model of new Set(models)) {
      const route = routeOf(provider, model)
      const entry =
        provider === 'openrouter' && flags.catalog !== 'off'
          ? catalogued.get(route.model)
          : undefined
      const override = entry === undefined ? undefined : budgetOverrideOf(entry)
      const listed: Planned = { route }

      if (override !== undefined) {
        listed.override = override
      }

      if (missing.length > 0) {
        listed.skip = `${missing.join(' and ')} unset`
      }

      planned.push(listed)
    }
  }

  return planned
}

/**
 * `fetch` as the global one takes it.
 */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

/**
 * The engine's ports over Bun's own: `fetch` over the global `fetch`, the
 * waits over `setTimeout`, and the signal of one compaction's controller,
 * which also cancels a request still out when it aborts.
 *
 * @param controller aborted to give the compaction up
 * @param fetchImpl the `fetch` requests go through
 * @returns the ports
 */
export function portsOf(
  controller: AbortController,
  fetchImpl: FetchImpl = fetch,
): Ports {
  return {
    fetch: async (url: string, init: HttpInit): Promise<HttpResponse> => {
      const fetched = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      })

      return {
        status: fetched.status,
        ok: fetched.ok,
        headers: Object.fromEntries(fetched.headers),
        text: await fetched.text(),
      }
    },
    // The bench has no hook budget, so a wait is never declined; it ends
    // with the attempt it belongs to or with the compaction, the way
    // `$.clock.sleep` does with its signal.
    pause: (ms, signal) =>
      new Promise<boolean>((resolve, reject) => {
        const ending = AbortSignal.any([controller.signal, signal])

        if (ending.aborted) {
          reject(ending.reason)

          return
        }

        const onAbort = () => {
          clearTimeout(timer)
          reject(ending.reason)
        }
        const timer = setTimeout(() => {
          ending.removeEventListener('abort', onAbort)
          resolve(true)
        }, ms)

        ending.addEventListener('abort', onAbort, { once: true })
      }),
    after: (ms, fn) => {
      const timer = setTimeout(fn, ms)

      return { cancel: () => clearTimeout(timer) }
    },
    signal: controller.signal,
  }
}

/**
 * The options one route is driven with: the provider decision off so the
 * route is the one used, the corpus's pinned tail, and a catalogue model's
 * budgets when its window is below the mod's default.
 *
 * @param route the provider and the model
 * @param override the budgets a catalogue model is held to, if any
 * @returns the configuration
 */
export function configFor(
  route: Route,
  override: Planned['override'],
): Config {
  return configOf({
    provider: route.provider,
    model: route.model,
    providerDecision: false,
    preserveRecentMessages: PRESERVE_RECENT,
    ...override,
  })
}

/**
 * The wording of a name the command line accepted.
 *
 * @param questions one of the `WORDINGS` names
 * @returns the wording; throws for a name that is none of them
 */
function wordingNamed(questions: string): Wording {
  const wording = wordingOf(questions)

  if (wording === undefined) {
    throw new Error(`no wording is named ${questions}`)
  }

  return wording
}

/**
 * One compaction of a scenario over one route, with only that provider's
 * credential. A wording other than `current` goes on the job, so `run()`
 * asks in it, and so do result heads; with `current` and no heads the job
 * is the one a compaction would get.
 *
 * @param scenario the conversation
 * @param route the provider and the model
 * @param override the budgets a catalogue model is held to, if any
 * @param credentials every credential resolved
 * @param ports the engine's ports
 * @param questions the name of the wording to ask in
 * @param resultHead the characters of each output the state shows
 * @returns the job for `run()`
 */
export function jobOf(
  scenario: Scenario,
  route: Route,
  override: Planned['override'],
  credentials: Credentials,
  ports: Ports,
  questions = 'current',
  resultHead = 0,
): Job {
  const job: Job = {
    messages: scenario.messages,
    config: configFor(route, override),
    credentials: credentialsFor([route.provider], credentials),
    ports,
  }

  if (questions !== 'current') {
    job.wording = wordingNamed(questions)
  }

  if (resultHead > 0) {
    job.state = { resultHead }
  }

  return job
}

export type BenchDeps = {
  run: (job: Job) => Promise<Result>
  now: () => number
  log: (line: string) => void
  credentials: Credentials
  /**
   * The `fetch` one compaction's requests go through; the global one when
   * absent.
   */
  fetchFor?: (route: Route, scenario: string, repeat: number) => FetchImpl
  /**
   * Called with the controller of each compaction as it starts.
   */
  started?: (controller: AbortController) => void
  /**
   * True once the bench is to start no further compaction.
   */
  stopped?: () => boolean
  /**
   * The name of the wording every compaction asks in; `current` when
   * absent.
   */
  questions?: string
  /**
   * The characters of each output every compaction's state shows; none
   * when absent.
   */
  resultHead?: number
}

/**
 * Drives every route over every scenario, `repeat` times each, strictly one
 * compaction at a time: the next starts only once the previous settled and
 * its controller was aborted, so the time measured is that compaction's
 * alone and no request of it is still out. A failure is recorded,
 * redacted with every credential, and the loop goes on.
 *
 * @param routes the routes to drive; skipped ones are passed over
 * @param scenarios the conversations
 * @param repeat compactions per route and scenario
 * @param deps what runs, times and prints
 * @returns one run per compaction, in the order they ran
 */
export async function benchOf(
  routes: readonly Planned[],
  scenarios: readonly Scenario[],
  repeat: number,
  deps: BenchDeps,
): Promise<Run[]> {
  const runs: Run[] = []
  const say = (line: string) => deps.log(redacted(line, deps.credentials))

  for (const planned of routes) {
    if (planned.skip !== undefined) {
      continue
    }

    const { route } = planned
    const label = `${route.provider}/${route.model}`

    for (const scenario of scenarios) {
      for (let index = 1; index <= repeat; index++) {
        if (deps.stopped?.() === true) {
          return runs
        }

        const controller = new AbortController()

        deps.started?.(controller)

        const ports = portsOf(
          controller,
          deps.fetchFor?.(route, scenario.id, index),
        )
        const job = jobOf(
          scenario,
          route,
          planned.override,
          deps.credentials,
          ports,
          deps.questions,
          deps.resultHead,
        )
        const t0 = deps.now()
        let ran: Run

        try {
          const result = await deps.run(job)

          ran = {
            route,
            scenario: scenario.id,
            repeat: index,
            ms: deps.now() - t0,
            result,
          }
        } catch (error) {
          ran = {
            route,
            scenario: scenario.id,
            repeat: index,
            ms: deps.now() - t0,
            failure: redacted(messageOf(error), deps.credentials),
          }
        } finally {
          // run() settles as soon as its outcome is known and leaves a
          // request that is still out to settle on its own; aborting the
          // compaction's controller withdraws it here, so that it neither
          // overlaps the next compaction nor holds the process open.
          controller.abort(new Error('compaction finished'))
        }

        runs.push(ran)
        say(
          ran.failure === undefined
            ? `ok ${label} ${scenario.id} #${index} ${Math.round(ran.ms)} ms`
            : `FAIL ${label} ${scenario.id} #${index}: ` +
                ran.failure.replace(/\s+/g, ' ').trim(),
        )
      }
    }
  }

  return runs
}

/**
 * The first request a dry run caught for one route and scenario, counted
 * without anything leaving the process.
 */
export type DryRow = {
  route: Route
  scenario: string
  override?: Planned['override']
  first?: {
    bodyBytes: number
    stateBytes: number
    stateTokens: number
    questions: number
  }
  /**
   * Whether the first request's state is smaller in bytes than the whole
   * state of the scenario, which is what an unbounded budget fits; absent
   * when no request was caught.
   */
  cut?: boolean
  failure?: string
}

/**
 * Sizes a request body as the route's wire format wrote it: the state is
 * `state` in the System One body and the string `input` in OpenAI's, and
 * the questions a map by id or a list.
 *
 * @param body the request body
 * @returns its bytes, the state's bytes and estimated tokens, the questions
 */
export function firstRequestOf(body: string): NonNullable<DryRow['first']> {
  const parsed: unknown = JSON.parse(body)
  const record =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  const stateJson =
    typeof record.input === 'string'
      ? record.input
      : JSON.stringify(record.state ?? null)
  const questions = record.questions

  return {
    bodyBytes: bytesOf(body),
    stateBytes: bytesOf(stateJson),
    stateTokens: estimatedTokensOf(stateJson),
    questions: Array.isArray(questions)
      ? questions.length
      : typeof questions === 'object' && questions !== null
        ? Object.keys(questions).length
        : 0,
  }
}

/**
 * Drives every route over every scenario once through the real `run()`
 * with a `fetch` that throws before anything is sent, and keeps the first
 * request each compaction would have sent. `run()` fits the state and
 * batches the questions before its first request, so that request is the
 * one that would go out; how many would follow is not known once it
 * throws.
 *
 * @param routes the routes; skipped ones are passed over
 * @param scenarios the conversations
 * @param deps what runs, times and prints, without `fetchFor`
 * @returns one row per route and scenario
 */
export async function dryRunOf(
  routes: readonly Planned[],
  scenarios: readonly Scenario[],
  deps: Omit<BenchDeps, 'fetchFor'>,
): Promise<DryRow[]> {
  const caught = new Map<string, string>()
  const keyOf = (route: Route, scenario: string) =>
    `${route.provider}\u0000${route.model}\u0000${scenario}`
  const runs = await benchOf(routes, scenarios, 1, {
    ...deps,
    // Silent: the dry run's own rows say what each compaction did.
    log: () => {},
    fetchFor: (route, scenario) => async (_url, init) => {
      const key = keyOf(route, scenario)

      // Up to three batches go out at once, so more than one may reach
      // here before the first failure stops the rest; the first is kept.
      if (!caught.has(key) && typeof init.body === 'string') {
        caught.set(key, init.body)
      }

      throw new DryRunSentinel()
    },
  })
  const overrides = new Map(
    routes.map(planned => [
      `${planned.route.provider}\u0000${planned.route.model}`,
      planned.override,
    ]),
  )
  const byId = new Map(scenarios.map(scenario => [scenario.id, scenario]))
  const wholeBytes = new Map<string, number>()
  // The whole state is what `stateWithin` fits at a budget nothing exceeds,
  // with no cap in bytes: its first rung, the same on every wire format,
  // since a wire format only changes how the state is measured. Its bytes
  // are counted as the first request's are, the state's own JSON, so the
  // two compare exactly on every route.
  const wholeBytesOf = (
    scenario: Scenario,
    route: Route,
    override: Planned['override'],
  ) => {
    const known = wholeBytes.get(scenario.id)

    if (known !== undefined) {
      return known
    }

    const preserve = configFor(route, override).preserveRecentMessages
    const questions = deps.questions ?? 'current'
    // Framed with the context the compactions asked in, so that a context
    // of another length is not counted as a cut, and with the heads they
    // showed. The mod's own wording is left to the mod, whose context
    // follows the heads; another wording's context is passed as the job
    // passes it.
    const whole = stateWithin(
      scenario.messages,
      pairCalls(scenario.messages, preserve),
      {
        maxStateTokens: Number.MAX_SAFE_INTEGER,
        preserveRecentMessages: preserve,
        goal: goalOf(scenario.messages),
        wire: wireOf(route),
        resultHead: deps.resultHead ?? 0,
        ...(questions === 'current'
          ? {}
          : { context: wordingNamed(questions).context }),
      },
    )
    const bytes = bytesOf(JSON.stringify(whole.state))

    wholeBytes.set(scenario.id, bytes)

    return bytes
  }

  return runs.map(ran => {
    const body = caught.get(keyOf(ran.route, ran.scenario))
    const override = overrides.get(
      `${ran.route.provider}\u0000${ran.route.model}`,
    )
    const scenario = byId.get(ran.scenario)
    const row: DryRow = { route: ran.route, scenario: ran.scenario }

    if (override !== undefined) {
      row.override = override
    }

    if (body !== undefined) {
      row.first = firstRequestOf(body)

      if (scenario !== undefined) {
        row.cut =
          row.first.stateBytes < wholeBytesOf(scenario, ran.route, override)
      }
    } else if (ran.failure !== undefined) {
      row.failure = ran.failure
    }

    return row
  })
}

/**
 * Renders the dry run's rows as one plain-text table. `cut` is `yes` when
 * the first request's state is smaller than the whole state, `no` when it
 * is the whole, and `-` when no request was caught.
 *
 * @param rows the rows
 * @returns the table
 */
export function dryTableOf(rows: readonly DryRow[]): string {
  const header = [
    'route',
    'scenario',
    'body bytes',
    'state bytes',
    'state tokens (est.)',
    'questions',
    'cut',
    'budget override',
  ]
  const lines = rows.map(row => {
    const override =
      row.override === undefined
        ? ''
        : `state ${row.override.maxStateTokens}, ` +
          `request ${row.override.maxRequestTokens}`

    if (row.first === undefined) {
      return [
        `${row.route.provider}/${row.route.model}`,
        row.scenario,
        row.failure === undefined
          ? 'no request: every call is pinned'
          : `would fail: ${row.failure.replace(/\s+/g, ' ').trim()}`,
        '',
        '',
        '',
        '-',
        override,
      ]
    }

    return [
      `${row.route.provider}/${row.route.model}`,
      row.scenario,
      String(row.first.bodyBytes),
      String(row.first.stateBytes),
      String(row.first.stateTokens),
      String(row.first.questions),
      row.cut === undefined ? '-' : row.cut ? 'yes' : 'no',
      override,
    ]
  })

  return [header, ...lines].map(cells => cells.join(' | ')).join('\n')
}

/**
 * The bench's exit status over its runs.
 *
 * @param runs every run
 * @returns 1 when any failed, 0 otherwise
 */
export function exitStatusOf(runs: readonly Run[]): 0 | 1 {
  return runs.some(ran => ran.failure !== undefined) ? 1 : 0
}

/**
 * The tool calls a scenario makes.
 */
function callsOf(scenario: Scenario): number {
  return scenario.messages.reduce(
    (sum, message) => sum + message.toolUses.length,
    0,
  )
}

/**
 * The JSON written with `--out`: ids, actions, probabilities and figures,
 * never a request body or a conversation's text, serialised once and
 * redacted whole.
 *
 * @param flags the command line
 * @param scenarios the scenarios that ran
 * @param records one per run
 * @param summaries one per route
 * @param credentials every credential resolved
 * @param writtenAt when the document is written
 * @returns the text to write
 */
export function outDocumentOf(
  flags: Flags,
  scenarios: readonly Scenario[],
  records: readonly RunRecord[],
  summaries: readonly RouteSummary[],
  credentials: Credentials,
  writtenAt: string,
): string {
  const document = {
    writtenAt,
    catalogFetchedAt: CATALOG_FETCHED_AT,
    flags,
    scenarios: scenarios.map(scenario => ({
      id: scenario.id,
      title: scenario.title,
      calls: callsOf(scenario),
    })),
    records,
    summaries,
  }

  return redacted(`${JSON.stringify(document, null, 2)}\n`, credentials)
}

/**
 * The OpenRouter-only models to drive: the table in the mod, none, or the
 * listing fetched now, after printing how it differs from the table.
 *
 * @param mode the `--openrouter-catalog` value
 * @param fetchImpl the `fetch` the listing is read through
 * @param log where the differences are printed
 * @returns the models
 */
export async function catalogOf(
  mode: CatalogMode,
  fetchImpl: FetchImpl,
  log: (line: string) => void,
): Promise<readonly CatalogEntry[]> {
  if (mode === 'off') {
    return []
  }

  if (mode === 'static') {
    return OPENROUTER_CATALOG
  }

  const response = await fetchImpl(OPENROUTER_LISTING_URL, {
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`the OpenRouter listing answered HTTP ${response.status}`)
  }

  const listed = openrouterOnlyOf(await response.json())
  const known = new Set(OPENROUTER_CATALOG.map(entry => entry.id))
  const live = new Set(listed.map(entry => entry.id))

  for (const id of live) {
    if (!known.has(id)) {
      log(
        `openrouter listing: ${id} is not in the table fetched ` +
          CATALOG_FETCHED_AT,
      )
    }
  }

  for (const entry of OPENROUTER_CATALOG) {
    if (!live.has(entry.id)) {
      log(
        `openrouter listing: ${entry.id} is in the table but no longer listed`,
      )
    }
  }

  return listed
}

/**
 * What the command line reads and drives, and where it prints: the
 * process's own when the script runs, others in tests, so that the whole
 * command line can run in-process without a network.
 */
export type MainIo = {
  env: Environment
  run: (job: Job) => Promise<Result>
  /**
   * The `fetch` the listing and every real request go through.
   */
  fetch: FetchImpl
  log: (line: string) => void
  error: (line: string) => void
}

/**
 * The process's own. The global `fetch` is looked up on each call rather
 * than when the module loads, so one put in its place later is the one
 * used.
 */
const PROCESS_IO: MainIo = {
  env: process.env as Environment,
  run,
  fetch: (url, init) => fetch(url, init),
  log: line => console.log(line),
  error: line => console.error(line),
}

/**
 * A count with its noun, plural unless the count is one.
 */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The command line, run.
 *
 * The credentials are resolved before anything else, and every line the
 * command line prints, an error's included, passes through the mod's
 * redaction with all of them: a mistake on the command line can repeat a
 * key, and a failure of the listing or of the write can quote one. Before
 * the first real request it prints how many compactions it plans and the
 * first request of each, as a dry run shows them, so the spend is seen
 * before it is incurred.
 *
 * @param argv the arguments after the script's path
 * @param io what it reads, drives and prints through
 * @returns the exit status: 1 when a run or the bench itself failed, 2 on a
 * usage error, 130 after an interrupt, 0 otherwise
 */
export async function main(
  argv: readonly string[],
  io: MainIo = PROCESS_IO,
): Promise<number> {
  const credentials = credentialsOf({}, io.env)
  const say = (line: string) => io.log(redacted(line, credentials))
  const complain = (line: string) => io.error(redacted(line, credentials))
  let current: AbortController | undefined
  let interrupted = false
  const onInterrupt = () => {
    if (interrupted) {
      process.exit(130)
    }

    interrupted = true
    current?.abort(new Error('the bench was interrupted'))
  }

  process.on('SIGINT', onInterrupt)

  try {
    const flags = parseArgs(argv)

    if (flags.help) {
      say(USAGE)

      return 0
    }

    const wantsOpenRouter =
      flags.providers.length === 0 || flags.providers.includes('openrouter')
    const catalog = await catalogOf(
      wantsOpenRouter ? flags.catalog : 'off',
      io.fetch,
      say,
    )
    const routes = routesOf(flags, credentials, catalog)
    const scenarios =
      flags.scenarios.length === 0
        ? SCENARIOS
        : flags.scenarios.map(id => scenarioOf(id) as Scenario)

    for (const planned of routes) {
      if (planned.skip !== undefined) {
        say(
          `skip ${planned.route.provider}/${planned.route.model}: ` +
            planned.skip,
        )
      }
    }

    const deps: Omit<BenchDeps, 'fetchFor'> = {
      run: io.run,
      now: () => performance.now(),
      log: say,
      credentials,
      started: controller => {
        current = controller
      },
      stopped: () => interrupted,
      questions: flags.questions,
      resultHead: resultHeadOf(flags.state) ?? 0,
    }
    const driven = routes.filter(planned => planned.skip === undefined)

    if (driven.length === 0) {
      return 0
    }

    if (flags.dryRun) {
      const rows = await dryRunOf(driven, scenarios, deps)

      say('')
      say(dryTableOf(rows))
      say('')
      say(
        'A dry run shows the first request as it would go out, not how many ' +
          'requests a compaction sends.',
      )

      return interrupted ? 130 : 0
    }

    const compactions = driven.length * scenarios.length * flags.repeat
    const isCurrent = flags.questions === 'current'

    say(
      `planned: ${countOf(compactions, 'compaction')} ` +
        `(${countOf(driven.length, 'route')} x ` +
        `${countOf(scenarios.length, 'scenario')} x ` +
        `${countOf(flags.repeat, 'repeat')})` +
        (isCurrent ? '' : ` with the questions ${flags.questions}`),
    )
    say(dryTableOf(await dryRunOf(driven, scenarios, deps)))
    say('')

    if (interrupted) {
      return 130
    }

    const runs = await benchOf(driven, scenarios, flags.repeat, {
      ...deps,
      fetchFor: () => io.fetch,
    })
    const records = runs.map(ran => {
      const scenario = scenarioOf(ran.scenario) as Scenario
      const planned = driven.find(
        candidate =>
          candidate.route.provider === ran.route.provider &&
          candidate.route.model === ran.route.model,
      )
      const { keepThreshold } = configFor(ran.route, planned?.override)

      return recordOf(ran, scenario.expected, keepThreshold)
    })
    const summaries = summariesOf(records)

    for (const scenario of scenarios) {
      const rows = records.filter(record => record.scenario === scenario.id)

      if (rows.length > 0) {
        say('')
        say(scenarioTableOf(scenario.id, rows))
      }
    }

    say('')
    say(summaryTableOf(summaries))
    say('')
    say(disputedLinesOf(disputedOf(records)))
    say('')
    say(CAVEAT)

    if (!isCurrent) {
      say(
        `The questions and the state's context were the ${flags.questions} ` +
          `wording (${wordingNamed(flags.questions).note}), not the mod's ` +
          'own.',
      )
    }

    if (flags.state !== 'none') {
      say(
        `The state showed up to the first ${resultHeadOf(flags.state)} ` +
          `characters of each call's output (--state ${flags.state}) ` +
          "unless its budget dropped them (stage 'result heads dropped'); " +
          'a compaction shows none.',
      )
    }

    if (flags.out !== undefined) {
      writeFileSync(
        flags.out,
        outDocumentOf(
          flags,
          scenarios,
          records,
          summaries,
          credentials,
          new Date().toISOString(),
        ),
      )
      say(`wrote ${flags.out}`)
    }

    return interrupted ? 130 : exitStatusOf(runs)
  } catch (error) {
    if (error instanceof UsageError) {
      complain(`${error.message}\n\n${USAGE}`)

      return 2
    }

    complain(`the bench failed: ${messageOf(error)}`)

    return 1
  } finally {
    // A listener left behind would outlive this command line: in a test
    // process, the next interrupt would find it already interrupted and end
    // the process.
    process.off('SIGINT', onInterrupt)
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
