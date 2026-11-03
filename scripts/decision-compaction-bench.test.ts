// The bench runner under bun, with no network: every `fetch` here is a stub
// that answers from memory or throws, and the global one is replaced by a
// counter wherever a request could in principle leave.
//
// Usage: bun test scripts/decision-compaction-bench.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  answering,
  calling,
  said,
  SCENARIOS,
  scenarioOf,
  withOutcomes,
} from '../mods/decision-compaction/bench/corpus'
import type { Scenario } from '../mods/decision-compaction/bench/corpus'
import {
  recordOf,
  summariesOf,
} from '../mods/decision-compaction/bench/metrics'
import {
  budgetOverrideOf,
  OPENROUTER_CATALOG,
} from '../mods/decision-compaction/bench/openrouter-catalog'
import { run } from '../mods/decision-compaction/hooks/run'
import type { Job, Result } from '../mods/decision-compaction/hooks/run'
import { modelsOf, PROVIDERS } from '../mods/decision-compaction/hooks/providers'
import type {
  Credentials,
  Route,
} from '../mods/decision-compaction/hooks/providers'

import {
  benchOf,
  catalogOf,
  configFor,
  DryRunSentinel,
  dryRunOf,
  dryTableOf,
  exitStatusOf,
  firstRequestOf,
  jobOf,
  main,
  OPENROUTER_LISTING_URL,
  outDocumentOf,
  parseArgs,
  portsOf,
  routesOf,
  UsageError,
} from './decision-compaction-bench'
import type {
  FetchImpl,
  Flags,
  MainIo,
  Planned,
} from './decision-compaction-bench'

// Fixture-shaped fakes, as obvious as the mod's own test fixtures.
const OPENROUTER_ONLY: Credentials = { openrouterApiKey: 'test-openrouter-key' }
const PLANTED = 'sk-planted-000'
const PLANTED_CREDENTIALS: Credentials = { openrouterApiKey: PLANTED }

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/**
 * Replaces the global `fetch` with one that counts its entries and refuses,
 * so a test proves nothing reached it.
 */
function countGlobalFetch(): { entries: number } {
  const counter = { entries: 0 }

  globalThis.fetch = Object.assign(
    async () => {
      counter.entries++
      throw new Error('the global fetch was entered')
    },
    { preconnect: () => {} },
  ) as typeof fetch

  return counter
}

/**
 * A conversation of three judged calls, then the six newest messages the
 * bench pins: an edit and a passing test run.
 */
function smallScenario(): Scenario {
  return {
    id: 'small',
    title: 'three judged calls',
    messages: withOutcomes([
      said('The parser test fails; please fix it.'),
      calling('Reading the parser.', [
        ['r1', 'Read', { file_path: '/repo/src/parse.ts' }],
      ]),
      answering([['r1', 'export function parse(text) { return text }\n']]),
      calling('Running the test.', [['b1', 'Bash', { command: 'pnpm test' }]]),
      answering([['b1', 'FAIL parse.test.ts: expected 1 got "1"', true]]),
      calling('Looking for callers.', [
        ['g1', 'Grep', { pattern: 'parse\\(' }],
      ]),
      answering([['g1', 'src/main.ts:4: parse(input)\n']]),
      calling('Fixing the parser.', [
        ['e1', 'Edit', { file_path: '/repo/src/parse.ts' }],
      ]),
      answering([['e1', 'The file was updated.']]),
      calling('Running the test again.', [
        ['b2', 'Bash', { command: 'pnpm test' }],
      ]),
      answering([['b2', 'PASS parse.test.ts']]),
      said('Thanks, that is done.'),
    ]),
    expected: {
      r1: ['truncate', 'drop'],
      b1: ['drop'],
      g1: ['keep', 'truncate'],
    },
  }
}

/**
 * A `fetch` that answers every question of a System One body with `noul`,
 * as OpenRouter's System One endpoint does, with a usage block and the
 * model it answered as.
 */
function answeringFetch(noul: number, model: string): FetchImpl {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as {
      questions: Record<string, unknown>
    }
    const answers = Object.fromEntries(
      Object.keys(body.questions).map(id => [id, { noul }]),
    )

    return new Response(
      JSON.stringify({ answers, usage: { input_tokens: 120 }, model }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
}

/**
 * Every key of a JSON value, at any depth.
 */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf)
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => [
      key,
      ...keysOf(inner),
    ])
  }

  return []
}

const DEFAULT_FLAGS: Flags = {
  providers: [],
  scenarios: [],
  repeat: 1,
  dryRun: false,
  catalog: 'static',
  help: false,
}

describe('parseArgs', () => {
  test('success: no flags gives every provider, scenario, one repeat', () => {
    expect(parseArgs([])).toEqual(DEFAULT_FLAGS)
  })

  test('success: --provider and --scenario repeat and keep their order', () => {
    const [first, second] = SCENARIOS

    expect(first).toBeDefined()
    expect(second).toBeDefined()

    const flags = parseArgs([
      '--provider',
      'openrouter',
      '--scenario',
      (second as Scenario).id,
      '--provider',
      'typesafe',
      '--scenario',
      (first as Scenario).id,
      '--provider',
      'openrouter',
      '--repeat',
      '3',
      '--openrouter-catalog',
      'off',
      '--out',
      '/tmp/bench.json',
    ])

    expect(flags).toEqual({
      ...DEFAULT_FLAGS,
      providers: ['openrouter', 'typesafe'],
      scenarios: [(second as Scenario).id, (first as Scenario).id],
      repeat: 3,
      catalog: 'off',
      out: '/tmp/bench.json',
    })
  })

  test('success: --model with exactly one --provider', () => {
    expect(
      parseArgs(['--provider', 'cloudflare', '--model', ' clef-flash ']),
    ).toEqual({
      ...DEFAULT_FLAGS,
      providers: ['cloudflare'],
      model: 'clef-flash',
    })
  })

  test('success: --dry-run and --help', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true)
    expect(parseArgs(['--help']).help).toBe(true)
  })

  const mistakes: Record<string, { argv: string[]; says: RegExp }> = {
    'error: --repeat 0': { argv: ['--repeat', '0'], says: /--repeat 0/ },
    'error: --repeat negative': {
      argv: ['--repeat', '-1'],
      says: /--repeat needs a value|--repeat -1/,
    },
    'error: --repeat fraction': {
      argv: ['--repeat', '1.5'],
      says: /--repeat 1.5/,
    },
    'error: --repeat word': { argv: ['--repeat', 'two'], says: /--repeat two/ },
    'error: --repeat without a value': {
      argv: ['--repeat'],
      says: /--repeat needs a value/,
    },
    'error: unknown flag': { argv: ['--fast'], says: /unknown flag --fast/ },
    'error: unknown provider': {
      argv: ['--provider', 'anthropic'],
      says: /--provider anthropic is none of/,
    },
    'error: unknown scenario': {
      argv: ['--scenario', 'no-such-scenario'],
      says: /--scenario no-such-scenario is none of/,
    },
    'error: unknown catalogue mode': {
      argv: ['--openrouter-catalog', 'cached'],
      says: /static, live, off/,
    },
    'error: --model without --provider': {
      argv: ['--model', 'jev-latest'],
      says: /exactly one --provider/,
    },
    'error: --model with two providers': {
      argv: [
        '--provider',
        'typesafe',
        '--provider',
        'openrouter',
        '--model',
        'jev-latest',
      ],
      says: /exactly one --provider/,
    },
    'error: --out with --dry-run': {
      argv: ['--dry-run', '--out', '/tmp/x.json'],
      says: /a dry run has none/,
    },
  }

  for (const [name, { argv, says }] of Object.entries(mistakes)) {
    test(name, () => {
      let thrown: unknown

      try {
        parseArgs(argv)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(UsageError)
      expect((thrown as Error).message).toMatch(says)
    })
  }
})

describe('routesOf', () => {
  const idsOf = (planned: readonly Planned[]) =>
    planned.map(({ route }) => `${route.provider}/${route.model}`)

  test('success: with only the OpenRouter key, OpenRouter models then the catalogue, in order', () => {
    const planned = routesOf(DEFAULT_FLAGS, OPENROUTER_ONLY, OPENROUTER_CATALOG)
    const driven = planned.filter(listed => listed.skip === undefined)

    expect(idsOf(driven)).toEqual([
      ...modelsOf('openrouter').map(model => `openrouter/${model}`),
      ...OPENROUTER_CATALOG.map(entry => `openrouter/${entry.id}`),
    ])

    // Every other provider's models are listed, each skipped by name.
    const skipped = planned.filter(listed => listed.skip !== undefined)

    expect(idsOf(skipped)).toEqual(
      PROVIDERS.filter(provider => provider !== 'openrouter').flatMap(
        provider => modelsOf(provider).map(model => `${provider}/${model}`),
      ),
    )
    expect(
      skipped.find(listed => listed.route.provider === 'typesafe')?.skip,
    ).toBe('TYPESAFE_API_KEY unset')
    expect(
      skipped.find(listed => listed.route.provider === 'cloudflare')?.skip,
    ).toBe('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset')
  })

  test('success: off drops the catalogue', () => {
    const planned = routesOf(
      { ...DEFAULT_FLAGS, catalog: 'off' },
      OPENROUTER_ONLY,
      [],
    )

    expect(
      idsOf(planned.filter(listed => listed.skip === undefined)),
    ).toEqual(modelsOf('openrouter').map(model => `openrouter/${model}`))
  })

  test('success: with no credential every route is a skip', () => {
    const planned = routesOf(DEFAULT_FLAGS, {}, OPENROUTER_CATALOG)

    expect(planned.length).toBe(
      PROVIDERS.reduce((sum, provider) => sum + modelsOf(provider).length, 0) +
        OPENROUTER_CATALOG.length,
    )
    expect(planned.every(listed => listed.skip !== undefined)).toBe(true)
  })

  test('success: --provider keeps PROVIDERS order', () => {
    const planned = routesOf(
      { ...DEFAULT_FLAGS, providers: ['openai', 'typesafe'] },
      {},
      OPENROUTER_CATALOG,
    )

    expect(idsOf(planned)).toEqual([
      ...modelsOf('typesafe').map(model => `typesafe/${model}`),
      ...modelsOf('openai').map(model => `openai/${model}`),
    ])
  })

  test('success: --model names one route and a catalogue model keeps its override', () => {
    const small = OPENROUTER_CATALOG.find(
      entry => budgetOverrideOf(entry) !== undefined,
    )

    expect(small).toBeDefined()

    const planned = routesOf(
      {
        ...DEFAULT_FLAGS,
        providers: ['openrouter'],
        model: (small as { id: string }).id,
      },
      OPENROUTER_ONLY,
      OPENROUTER_CATALOG,
    )

    expect(planned).toEqual([
      {
        route: { provider: 'openrouter', model: (small as { id: string }).id },
        override: budgetOverrideOf(small as (typeof OPENROUTER_CATALOG)[number]),
      },
    ])
  })
})

describe('catalogOf', () => {
  const silent = () => {}

  test('success: static is the table and off is nothing, with no request', async () => {
    const counter = countGlobalFetch()

    expect(await catalogOf('static', globalThis.fetch, silent)).toBe(
      OPENROUTER_CATALOG,
    )
    expect(await catalogOf('off', globalThis.fetch, silent)).toEqual([])
    expect(counter.entries).toBe(0)
  })

  test('success: live reports an id the table lacks once, and one it lost', async () => {
    const lines: string[] = []
    const requested: string[] = []
    const listing = listingOf([
      ...OPENROUTER_CATALOG.slice(1),
      {
        id: 'newvendor/decide-1',
        vendor: 'newvendor',
        contextLength: 65_536,
        promptPricePerToken: 0.00000002,
      },
    ])
    const fetchImpl: FetchImpl = async url => {
      requested.push(url)

      return new Response(JSON.stringify(listing), { status: 200 })
    }

    const live = await catalogOf('live', fetchImpl, line => lines.push(line))

    expect(requested).toEqual([OPENROUTER_LISTING_URL])
    expect(live.map(entry => entry.id)).toContain('newvendor/decide-1')
    expect(
      lines.filter(line => line.includes('newvendor/decide-1')),
    ).toHaveLength(1)
    expect(
      lines.filter(line =>
        line.includes((OPENROUTER_CATALOG[0] as { id: string }).id),
      ),
    ).toHaveLength(1)
    expect(lines).toHaveLength(2)
  })

  test('success: live with the table as listed reports nothing', async () => {
    const lines: string[] = []
    const fetchImpl: FetchImpl = async () =>
      new Response(JSON.stringify(listingOf(OPENROUTER_CATALOG)), {
        status: 200,
      })

    await catalogOf('live', fetchImpl, line => lines.push(line))

    expect(lines).toEqual([])
  })

  test('error: live with a failing listing throws its status', async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response('busy', { status: 503 })

    await expect(catalogOf('live', fetchImpl, silent)).rejects.toThrow(
      'HTTP 503',
    )
  })
})

describe('jobOf', () => {
  test('success: a catalogue model below the default window is held to it', () => {
    const small = OPENROUTER_CATALOG.filter(
      entry => budgetOverrideOf(entry) !== undefined,
    )

    expect(small.length).toBeGreaterThan(0)

    for (const entry of small) {
      const override = budgetOverrideOf(entry)
      const job = jobOf(
        smallScenario(),
        { provider: 'openrouter', model: entry.id },
        override,
        OPENROUTER_ONLY,
        portsOf(new AbortController()),
      )

      expect(job.config.maxStateTokens).toBe(entry.contextLength)
      expect(job.config.maxRequestTokens).toBe(entry.contextLength)
      expect(job.config.providerDecision).toBe(false)
      expect(job.config.provider).toBe('openrouter')
      expect(job.config.model).toBe(entry.id)
    }
  })

  test('success: no override leaves the route its own budgets, and only its own key goes on', () => {
    const job = jobOf(
      smallScenario(),
      { provider: 'typesafe', model: 'jev-latest' },
      undefined,
      {
        typesafeApiKey: 'test-typesafe-key',
        openrouterApiKey: 'test-openrouter-key',
      },
      portsOf(new AbortController()),
    )

    expect(job.config.maxStateTokens).toBeUndefined()
    expect(job.config.maxRequestTokens).toBeUndefined()
    expect(job.credentials).toEqual({ typesafeApiKey: 'test-typesafe-key' })
  })
})

describe('portsOf', () => {
  test('success: pause resolves true after the wait', async () => {
    const ports = portsOf(new AbortController())

    expect(await ports.pause(5, new AbortController().signal)).toBe(true)
  })

  test('error: pause ends with the reason when its signal aborts first', async () => {
    const ports = portsOf(new AbortController())
    const attempt = new AbortController()
    const reason = new Error('the attempt is over')
    const waiting = ports.pause(10_000, attempt.signal)

    attempt.abort(reason)

    await expect(waiting).rejects.toBe(reason)
  })

  test('error: pause ends with the compaction when its controller aborts', async () => {
    const controller = new AbortController()
    const ports = portsOf(controller)
    const reason = new Error('interrupted')
    const waiting = ports.pause(10_000, new AbortController().signal)

    controller.abort(reason)

    await expect(waiting).rejects.toBe(reason)
  })

  test('error: pause on an aborted signal rejects at once', async () => {
    const ports = portsOf(new AbortController())
    const reason = new Error('already over')

    await expect(ports.pause(10_000, AbortSignal.abort(reason))).rejects.toBe(
      reason,
    )
  })

  test('success: after runs once, and not at all once cancelled', async () => {
    const ports = portsOf(new AbortController())
    let ran = 0
    let cancelledRan = 0

    ports.after(1, () => ran++)
    ports.after(1, () => cancelledRan++).cancel()
    await Bun.sleep(20)

    expect(ran).toBe(1)
    expect(cancelledRan).toBe(0)
  })

  test('success: fetch maps the response and carries the controller signal', async () => {
    const controller = new AbortController()
    let seen: RequestInit | undefined
    const ports = portsOf(controller, async (_url, init) => {
      seen = init

      return new Response('{"ok":1}', {
        status: 201,
        headers: { 'X-Thing': 'yes' },
      })
    })

    const response = await ports.fetch('https://example.invalid/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response).toEqual({
      status: 201,
      ok: true,
      // Header names come back lower-cased, as `$.http.fetch` gives them.
      headers: { 'x-thing': 'yes' },
      text: '{"ok":1}',
    })
    expect(seen?.signal).toBe(controller.signal)
    expect(seen?.body).toBe('{}')
    expect(ports.signal).toBe(controller.signal)
  })
})

describe('benchOf', () => {
  const routes: Planned[] = [
    { route: { provider: 'openrouter', model: '~typesafe/jev-latest' } },
    {
      route: { provider: 'typesafe', model: 'jev-latest' },
      skip: 'TYPESAFE_API_KEY unset',
    },
    { route: { provider: 'openrouter', model: 'baseten/joey-1' } },
  ]
  const scenarios = [smallScenario(), { ...smallScenario(), id: 'small-2' }]

  test('success: one compaction at a time, route then scenario then repeat', async () => {
    const spans: { what: string; start: number; end: number }[] = []
    let clock = 0
    const stub = async (job: Job): Promise<Result> => {
      const start = performance.now()

      await Bun.sleep(3)
      spans.push({
        what: `${job.config.model}`,
        start,
        end: performance.now(),
      })

      throw new Error('stubbed')
    }

    const runs = await benchOf(routes, scenarios, 2, {
      run: stub,
      now: () => clock++,
      log: () => {},
      credentials: OPENROUTER_ONLY,
    })

    expect(
      runs.map(ran => `${ran.route.model} ${ran.scenario} #${ran.repeat}`),
    ).toEqual([
      '~typesafe/jev-latest small #1',
      '~typesafe/jev-latest small #2',
      '~typesafe/jev-latest small-2 #1',
      '~typesafe/jev-latest small-2 #2',
      'baseten/joey-1 small #1',
      'baseten/joey-1 small #2',
      'baseten/joey-1 small-2 #1',
      'baseten/joey-1 small-2 #2',
    ])
    expect(spans).toHaveLength(8)

    let overlap = 0

    for (let index = 1; index < spans.length; index++) {
      if (
        (spans[index] as { start: number }).start <
        (spans[index - 1] as { end: number }).end
      ) {
        overlap++
      }
    }

    expect(overlap).toBe(0)
    // Each run's time is taken around its own run() alone.
    expect(runs.every(ran => ran.ms === 1)).toBe(true)
  })

  test('success: a catalogue override reaches the Config run() is given', async () => {
    const small = OPENROUTER_CATALOG.find(
      entry => budgetOverrideOf(entry) !== undefined,
    ) as (typeof OPENROUTER_CATALOG)[number]
    const configs: Job['config'][] = []

    await benchOf(
      [
        {
          route: { provider: 'openrouter', model: small.id },
          override: budgetOverrideOf(small),
        },
      ],
      [smallScenario()],
      1,
      {
        run: async job => {
          configs.push(job.config)
          throw new Error('stubbed')
        },
        now: () => 0,
        log: () => {},
        credentials: OPENROUTER_ONLY,
      },
    )

    expect(configs).toHaveLength(1)
    expect(configs[0]?.maxStateTokens).toBe(small.contextLength)
    expect(configs[0]?.maxRequestTokens).toBe(small.contextLength)
  })

  test('error: a failure is recorded redacted, printed redacted, and the loop goes on', async () => {
    const lines: string[] = []
    let calls = 0
    const runs = await benchOf(routes, [smallScenario()], 1, {
      run: async () => {
        calls++
        throw new Error(
          `openrouter answered HTTP 401: key ${PLANTED} rejected; ` +
            'Authorization: Bearer abcdef123456',
        )
      },
      now: () => 0,
      log: line => lines.push(line),
      credentials: PLANTED_CREDENTIALS,
    })

    expect(calls).toBe(2)
    expect(runs).toHaveLength(2)

    for (const ran of runs) {
      expect(ran.failure).toBeDefined()
      expect(ran.failure).not.toContain(PLANTED)
      expect(ran.failure).not.toMatch(/Bearer [A-Za-z0-9]/)
      expect(ran.failure).toContain('[redacted]')
    }

    expect(lines).toHaveLength(2)
    expect(lines.join('\n')).not.toMatch(/sk-|Bearer [A-Za-z0-9]/)
    expect(lines[0]).toStartWith('FAIL openrouter/~typesafe/jev-latest small')
    expect(exitStatusOf(runs)).toBe(1)
  })

  test('success: stops before the next compaction once stopped', async () => {
    let started = 0
    const controllers: AbortController[] = []
    const runs = await benchOf(routes, scenarios, 1, {
      run: async () => {
        started++
        throw new Error('stubbed')
      },
      now: () => 0,
      log: () => {},
      credentials: OPENROUTER_ONLY,
      started: controller => controllers.push(controller),
      stopped: () => started >= 1,
    })

    expect(runs).toHaveLength(1)
    expect(controllers).toHaveLength(1)
  })

  test('success: a request still out when run() settles is aborted before the next compaction starts', async () => {
    const exploration = scenarioOf('exploration') as Scenario
    // Eight questions a request, two a call: the scenario needs several
    // batches, and the first three go out together.
    const route: Route = { provider: 'decisions-api-dev', model: 'jev-latest' }
    let calls = 0
    let pending = 0
    let firstSignal: AbortSignal | undefined
    const atStart: { pending: number; firstAborted?: boolean }[] = []
    // The first request never answers; it ends only when its signal aborts.
    // The next one is refused for good, which ends the compaction while the
    // first is still out.
    const fetchImpl: FetchImpl = (_url, init) => {
      calls++

      if (calls === 1) {
        const signal = init.signal as AbortSignal

        firstSignal = signal
        pending++

        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              pending--
              reject(signal.reason)
            },
            { once: true },
          )
        })
      }

      return Promise.resolve(
        new Response('{"error":{"message":"bad request"}}', { status: 400 }),
      )
    }

    const runs = await benchOf(
      [{ route }],
      [exploration, { ...exploration, id: 'exploration-again' }],
      1,
      {
        run,
        now: () => performance.now(),
        log: () => {},
        credentials: { decisionsApiKey: 'test-decisions-key' },
        fetchFor: () => fetchImpl,
        started: () => {
          atStart.push(
            firstSignal === undefined
              ? { pending }
              : { pending, firstAborted: firstSignal.aborted },
          )
        },
      },
    )

    expect(runs).toHaveLength(2)
    expect(runs[0]?.failure).toMatch(/400/)
    expect(firstSignal).toBeDefined()
    expect(atStart).toEqual([
      { pending: 0 },
      { pending: 0, firstAborted: true },
    ])
    expect(pending).toBe(0)
  })

  test('success: the real run() over an answering stub, then a route whose reply cannot be read', async () => {
    const lines: string[] = []
    const runs = await benchOf(
      [
        { route: { provider: 'openrouter', model: 'liquid/d1' } },
        { route: { provider: 'openrouter', model: '~typesafe/jev-latest' } },
      ],
      [smallScenario()],
      1,
      {
        run,
        now: () => performance.now(),
        log: line => lines.push(line),
        credentials: OPENROUTER_ONLY,
        fetchFor: route =>
          route.model === 'liquid/d1'
            ? async () =>
                new Response(JSON.stringify({ scores: [0.1, 0.9] }), {
                  status: 200,
                })
            : answeringFetch(0.9, 'typesafe/jev-1.14'),
      },
    )

    expect(runs).toHaveLength(2)
    expect(runs[0]?.failure).toMatch(/answers/)
    expect(runs[0]?.result).toBeUndefined()
    expect(runs[1]?.failure).toBeUndefined()
    expect(runs[1]?.result?.outcome.decisions.length).toBeGreaterThan(0)
    expect(lines[0]).toStartWith('FAIL openrouter/liquid/d1 small #1:')
    expect(lines[1]).toStartWith('ok openrouter/~typesafe/jev-latest small #1')
    expect(exitStatusOf(runs)).toBe(1)
    expect(exitStatusOf(runs.slice(1))).toBe(0)
  })
})

describe('outDocumentOf', () => {
  test('success: ids and figures only, no text, no request, no key', async () => {
    const scenario = smallScenario()
    const route: Route = { provider: 'openrouter', model: '~typesafe/jev-latest' }
    const runs = await benchOf([{ route }], [scenario], 2, {
      run,
      now: () => performance.now(),
      log: () => {},
      credentials: PLANTED_CREDENTIALS,
      // A provider that echoes the key in the model it answered as: the
      // whole document is redacted once more before it is written.
      fetchFor: () => answeringFetch(0.2, `typesafe/jev-1.14 ${PLANTED}`),
    })
    const failed = await benchOf([{ route }], [scenario], 1, {
      run: async () => {
        throw new Error(`refused ${PLANTED}`)
      },
      now: () => 0,
      log: () => {},
      credentials: PLANTED_CREDENTIALS,
    })
    const { keepThreshold } = configFor(route, undefined)
    const records = [...runs, ...failed].map(ran =>
      recordOf(ran, scenario.expected, keepThreshold),
    )
    const written = outDocumentOf(
      { ...DEFAULT_FLAGS, out: '/tmp/bench.json' },
      [scenario],
      records,
      summariesOf(records),
      PLANTED_CREDENTIALS,
      '2026-11-03T00:00:00.000Z',
    )

    expect(written).not.toContain(PLANTED)
    expect(written).not.toMatch(/sk-|Bearer [A-Za-z0-9]/)
    expect(written).not.toContain('parse.test.ts')

    const document = JSON.parse(written) as Record<string, unknown>
    const forbidden = new Set(['state', 'text', 'input', 'authorization'])

    expect(
      keysOf(document).filter(key => forbidden.has(key.toLowerCase())),
    ).toEqual([])
    expect(Object.keys(document)).toEqual([
      'writtenAt',
      'catalogFetchedAt',
      'flags',
      'scenarios',
      'records',
      'summaries',
    ])
    expect(document.scenarios).toEqual([
      { id: 'small', title: 'three judged calls', calls: 5 },
    ])
    expect((document.records as unknown[]).length).toBe(3)
  })
})

describe('dry run', () => {
  test('success: the real run() reaches the sentinel, never the network', async () => {
    const counter = countGlobalFetch()
    const rows = await dryRunOf(
      [
        { route: { provider: 'openrouter', model: '~typesafe/jev-latest' } },
        {
          route: { provider: 'openai', model: 'gpt-6-luna' },
        },
        {
          route: { provider: 'typesafe', model: 'jev-latest' },
          skip: 'TYPESAFE_API_KEY unset',
        },
      ],
      [smallScenario()],
      {
        run,
        now: () => performance.now(),
        log: () => {},
        credentials: {
          openrouterApiKey: 'test-openrouter-key',
          openaiApiKey: 'test-openai-key',
        },
      },
    )

    expect(counter.entries).toBe(0)
    expect(rows).toHaveLength(2)

    for (const row of rows) {
      expect(row.failure).toBeUndefined()
      expect(row.first?.questions).toBeGreaterThan(0)
      expect(row.first?.stateBytes).toBeGreaterThan(0)
      expect(row.first?.stateTokens).toBeGreaterThan(0)
      expect(row.first?.bodyBytes).toBeGreaterThan(
        row.first?.stateBytes ?? Infinity,
      )
    }

    const table = dryTableOf(rows)

    expect(table.split('\n')).toHaveLength(3)
    expect(table).toContain('openrouter/~typesafe/jev-latest | small |')
    expect(table).toContain('openai/gpt-6-luna | small |')
  })

  test("success: the corpus's fix-test goes through the real run() to the sentinel", async () => {
    const counter = countGlobalFetch()
    const fixTest = scenarioOf('fix-test')

    expect(fixTest).toBeDefined()

    const rows = await dryRunOf(
      [{ route: { provider: 'openrouter', model: '~typesafe/jev-latest' } }],
      [fixTest as Scenario],
      { run, now: () => 0, log: () => {}, credentials: OPENROUTER_ONLY },
    )

    expect(counter.entries).toBe(0)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.failure).toBeUndefined()
    expect(rows[0]?.first?.questions).toBeGreaterThan(0)
  })

  test('success: a route that would fail before sending says why', async () => {
    const counter = countGlobalFetch()
    // No credential reaches the job: run() refuses before fitting.
    const rows = await dryRunOf(
      [{ route: { provider: 'openrouter', model: 'baseten/joey-1' } }],
      [smallScenario()],
      { run, now: () => 0, log: () => {}, credentials: {} },
    )

    expect(counter.entries).toBe(0)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.first).toBeUndefined()
    expect(rows[0]?.failure).toContain('OPENROUTER_API_KEY')
    expect(dryTableOf(rows)).toContain('would fail:')
  })

  test('success: the sentinel is an Error of its own', () => {
    const sentinel = new DryRunSentinel()

    expect(sentinel).toBeInstanceOf(Error)
    expect(sentinel.message).toBe('dry run: nothing is sent')
  })

  test('success: dryTableOf prints a budget override', () => {
    const table = dryTableOf([
      {
        route: { provider: 'openrouter', model: 'jaredpalmer/kev-4b' },
        scenario: 'small',
        override: { maxStateTokens: 8192, maxRequestTokens: 8192 },
        first: { bodyBytes: 900, stateBytes: 700, stateTokens: 200, questions: 6 },
        cut: true,
      },
    ])

    expect(table.split('\n')[1]).toBe(
      'openrouter/jaredpalmer/kev-4b | small | 900 | 700 | 200 | 6 | yes | ' +
        'state 8192, request 8192',
    )
  })

  test('success: cut says which route sends less than the whole state, through the real run()', async () => {
    const counter = countGlobalFetch()
    const large = scenarioOf('large')
    const fixTest = scenarioOf('fix-test')

    expect(large).toBeDefined()
    expect(fixTest).toBeDefined()

    const routes: Planned[] = [
      { route: { provider: 'cloudflare', model: 'clef-flash' } },
      { route: { provider: 'typesafe', model: 'jev-latest' } },
      // OpenAI's wire measures the state escaped once more, so it tells a
      // comparison of the state's own bytes from one in the wire's tokens.
      { route: { provider: 'openai', model: 'gpt-6-luna' } },
    ]
    const rows = await dryRunOf(
      routes,
      [large as Scenario, fixTest as Scenario],
      {
        run,
        now: () => 0,
        log: () => {},
        credentials: {
          typesafeApiKey: 'test-typesafe-key',
          cloudflareApiToken: 'test-cloudflare-token',
          cloudflareAccountId: 'test-account',
          openaiApiKey: 'test-openai-key',
        },
      },
    )
    const cutOf = (route: string, scenario: string) =>
      rows.find(
        row =>
          `${row.route.provider}/${row.route.model}` === route &&
          row.scenario === scenario,
      )?.cut

    expect(counter.entries).toBe(0)
    expect(rows).toHaveLength(6)
    expect(rows.map(row => row.failure)).toEqual(Array(6).fill(undefined))
    expect(cutOf('cloudflare/clef-flash', 'large')).toBe(true)
    expect(cutOf('typesafe/jev-latest', 'large')).toBe(false)
    expect(cutOf('openai/gpt-6-luna', 'large')).toBe(false)
    expect(cutOf('cloudflare/clef-flash', 'fix-test')).toBe(false)
    expect(cutOf('typesafe/jev-latest', 'fix-test')).toBe(false)
    expect(cutOf('openai/gpt-6-luna', 'fix-test')).toBe(false)

    const lines = dryTableOf(rows).split('\n')

    expect(lines[0]).toContain('| questions | cut | budget override')
    expect(lines.find(line => line.startsWith('cloudflare/clef-flash | large |'))).toMatch(/ \| yes \| $/)
    expect(lines.find(line => line.startsWith('typesafe/jev-latest | large |'))).toMatch(/ \| no \| $/)
    expect(lines.find(line => line.startsWith('typesafe/jev-latest | fix-test |'))).toMatch(/ \| no \| $/)
  })

  test('success: a row with no request prints - for cut', () => {
    const line = dryTableOf([
      {
        route: { provider: 'openrouter', model: 'baseten/joey-1' },
        scenario: 'small',
        failure: 'OPENROUTER_API_KEY is not set',
      },
    ]).split('\n')[1]

    expect(line).toBe(
      'openrouter/baseten/joey-1 | small | would fail: OPENROUTER_API_KEY is not set |  |  |  | - | ',
    )
  })
})

describe('firstRequestOf', () => {
  test('success: a System One body, state as JSON and questions by id', () => {
    const state = { conversation: [{ role: 'user', text: 'hello' }] }
    const body = JSON.stringify({
      model: 'jev-latest',
      state,
      questions: { a: { type: 'noul' }, b: { type: 'noul' } },
    })

    expect(firstRequestOf(body)).toEqual({
      bodyBytes: new TextEncoder().encode(body).length,
      stateBytes: JSON.stringify(state).length,
      stateTokens: expect.any(Number),
      questions: 2,
    })
  })

  test("success: OpenAI's body, state as a string and questions as a list", () => {
    const input = JSON.stringify({ conversation: ['héllo'] })
    const body = JSON.stringify({
      model: 'gpt-6-luna',
      input,
      questions: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    })
    const first = firstRequestOf(body)

    expect(first.questions).toBe(3)
    expect(first.stateBytes).toBe(new TextEncoder().encode(input).length)
  })
})

/**
 * The OpenRouter listing as `GET /api/v1/models` returns it, for the given
 * models.
 */
function listingOf(entries: readonly (typeof OPENROUTER_CATALOG)[number][]) {
  return {
    data: entries.map(entry => ({
      id: entry.id,
      context_length: entry.contextLength,
      pricing: { prompt: String(entry.promptPricePerToken) },
      architecture: { output_modalities: ['decisions'] },
    })),
  }
}

/**
 * Every value of a JSON value that is a string, at any depth.
 */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.flatMap(stringsOf)
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(stringsOf)
  }

  return []
}

/**
 * The command line's io with only the OpenRouter key set, printing into
 * `lines`; `over` replaces any part.
 */
function ioWith(lines: string[], over: Partial<MainIo> = {}): MainIo {
  return {
    env: { OPENROUTER_API_KEY: 'test-openrouter-key' },
    run,
    fetch: async () => {
      throw new Error('no request is expected here')
    },
    log: line => lines.push(line),
    error: line => lines.push(`error: ${line}`),
    ...over,
  }
}

/**
 * One route and one scenario, OpenRouter's own Jev on `fix-test`.
 */
const ONE_ROUTE = [
  '--provider',
  'openrouter',
  '--openrouter-catalog',
  'off',
  '--scenario',
  'fix-test',
]

describe('main', () => {
  const SCRIPT = join(import.meta.dir, 'decision-compaction-bench.ts')

  test('error: a usage error that repeats a key prints it redacted and exits 2', () => {
    const planted = 'test-review-planted-key'
    const ran = Bun.spawnSync(
      [process.execPath, SCRIPT, '--scenario', planted],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          OPENROUTER_API_KEY: planted,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const printed = `${ran.stdout.toString()}${ran.stderr.toString()}`

    expect(ran.exitCode).toBe(2)
    expect(printed).toContain('--scenario [redacted] is none of')
    expect(printed).toContain('usage: bun scripts/decision-compaction-bench.ts')
    expect(printed).not.toContain(planted)
  })

  test('error: a failure of the listing that quotes a key prints it redacted and exits 1', async () => {
    const lines: string[] = []
    const status = await main(
      ['--provider', 'openrouter', '--openrouter-catalog', 'live', '--dry-run'],
      ioWith(lines, {
        env: { OPENROUTER_API_KEY: PLANTED },
        fetch: async () => {
          throw new Error(`refused for ${PLANTED}`)
        },
      }),
    )

    expect(status).toBe(1)
    expect(lines).toEqual(['error: the bench failed: refused for [redacted]'])
  })

  test('error: a failure of the write that quotes a key prints it redacted and exits 1', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'decision-compaction-bench-'))
    const lines: string[] = []

    try {
      // A folder that does not exist, named after the key, so the error
      // the write throws quotes it.
      const status = await main(
        [...ONE_ROUTE, '--out', join(directory, PLANTED, 'bench.json')],
        ioWith(lines, {
          env: { OPENROUTER_API_KEY: PLANTED },
          fetch: answeringFetch(0.9, 'typesafe/jev-1.14'),
        }),
      )
      const errors = lines.filter(line => line.startsWith('error: '))

      expect(status).toBe(1)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toStartWith('error: the bench failed: ')
      expect(errors[0]).toContain('[redacted]')
      expect(lines.join('\n')).not.toContain(PLANTED)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('success: --help prints the usage and exits 0', async () => {
    const lines: string[] = []

    expect(await main(['--help'], ioWith(lines))).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(
      'usage: bun scripts/decision-compaction-bench.ts',
    )
  })

  test('success: the plan and the first requests are printed before the first request goes out', async () => {
    const counter = countGlobalFetch()
    const events: string[] = []
    const listeners = process.listenerCount('SIGINT')
    const status = await main(
      [...ONE_ROUTE, '--scenario', 'all-needed'],
      ioWith([], {
        log: line => events.push(`log ${line}`),
        fetch: async (url, init) => {
          events.push('fetch')

          return answeringFetch(0.9, 'typesafe/jev-1.14')(url, init)
        },
      }),
    )
    const planned = events.indexOf(
      'log planned: 2 compactions (1 route x 2 scenarios x 1 repeat)',
    )
    const table = events.findIndex(event =>
      event.startsWith('log route | scenario | body bytes'),
    )
    const firstFetch = events.indexOf('fetch')

    expect(status).toBe(0)
    expect(counter.entries).toBe(0)
    expect(planned).toBeGreaterThanOrEqual(0)
    expect(table).toBeGreaterThan(planned)
    expect(firstFetch).toBeGreaterThan(table)
    expect(events[table]).toContain(
      'openrouter/~typesafe/jev-latest | fix-test |',
    )
    expect(events[table]).toContain(
      'openrouter/~typesafe/jev-latest | all-needed |',
    )
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })

  test('success: the disputed calls are printed after the summary and before the caveat', async () => {
    const lines: string[] = []
    const status = await main(
      ONE_ROUTE,
      ioWith(lines, { fetch: answeringFetch(0.9, 'typesafe/jev-1.14') }),
    )
    const text = lines.join('\n')
    const summary = text.indexOf('route  ')
    const disputed = text.search(
      /^(disputed |no call disputed by every route)/m,
    )
    const caveat = text.indexOf('These figures compare routes')

    expect(status).toBe(0)
    expect(summary).toBeGreaterThanOrEqual(0)
    expect(disputed).toBeGreaterThan(summary)
    expect(caveat).toBeGreaterThan(disputed)
  })

  test('success: --out writes a file with no text, request or key in it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'decision-compaction-bench-'))
    const out = join(directory, 'bench.json')
    const lines: string[] = []

    try {
      const status = await main(
        [...ONE_ROUTE, '--repeat', '2', '--out', out],
        ioWith(lines, {
          env: { OPENROUTER_API_KEY: PLANTED },
          // A provider that echoes the key in the model it answered as.
          fetch: answeringFetch(0.2, `typesafe/jev-1.14 ${PLANTED}`),
        }),
      )
      const written = readFileSync(out, 'utf8')
      const document: unknown = JSON.parse(written)
      const forbidden = new Set(['state', 'text', 'input', 'authorization'])

      expect(status).toBe(0)
      expect(lines.at(-1)).toBe(`wrote ${out}`)
      expect(
        keysOf(document).filter(key => forbidden.has(key.toLowerCase())),
      ).toEqual([])
      expect(written).not.toContain(PLANTED)
      expect(
        stringsOf(document).some(value => value.includes('[redacted]')),
      ).toBe(true)
      expect(lines.join('\n')).not.toContain(PLANTED)
      expect(
        (document as { records: unknown[] }).records,
        'two repeats of one route and one scenario',
      ).toHaveLength(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('error: an interrupt during a dry run stops it and exits 130', async () => {
    const counter = countGlobalFetch()
    const listeners = process.listenerCount('SIGINT')
    let calls = 0
    const status = await main(
      [...ONE_ROUTE, '--scenario', 'all-needed', '--dry-run'],
      ioWith([], {
        run: async job => {
          calls++

          if (calls === 1) {
            process.emit('SIGINT')
          }

          return run(job)
        },
      }),
    )

    expect(status).toBe(130)
    expect(calls, 'no compaction starts after the interrupt').toBe(1)
    expect(counter.entries).toBe(0)
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })

  test('error: an interrupt during a real run stops it and exits 130', async () => {
    const counter = countGlobalFetch()
    const listeners = process.listenerCount('SIGINT')
    let calls = 0
    let fetched = 0
    const status = await main(
      [...ONE_ROUTE, '--scenario', 'all-needed'],
      ioWith([], {
        run: async job => {
          calls++

          // The plan's dry run takes the first two; the third is the first
          // real compaction.
          if (calls === 3) {
            process.emit('SIGINT')
          }

          return run(job)
        },
        fetch: async (url, init) => {
          fetched++

          return answeringFetch(0.9, 'typesafe/jev-1.14')(url, init)
        },
      }),
    )

    expect(status).toBe(130)
    expect(calls, 'no compaction starts after the interrupt').toBe(3)
    expect(fetched, 'the interrupted compaction sends nothing').toBe(0)
    expect(counter.entries).toBe(0)
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })
})
