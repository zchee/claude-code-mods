import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { PRESERVE_RECENT, SCENARIOS, scenarioOf } from '../bench/corpus'
import type { Scenario } from '../bench/corpus'
import {
  CATALOG_FETCHED_AT,
  DIRECT_VENDORS,
  OPENROUTER_CATALOG,
  budgetOverrideOf,
  openrouterOnlyOf,
  vendorOf,
} from '../bench/openrouter-catalog'
import type { CatalogEntry } from '../bench/openrouter-catalog'
import { routeOf, wireOf } from '../hooks/providers'
import type { Route } from '../hooks/providers'
import { goalOf, pairCalls, stateWithin } from '../hooks/state'
import type { Stage } from '../hooks/state'
import { ADDED_ENV, ENV } from './fixtures'

/**
 * Each scenario's size: its calls, answered ones pinned included, and about
 * how many characters its texts and results hold together.
 */
const SIZES: Readonly<Record<string, readonly [number, number]>> = {
  'fix-test': [6, 15_000],
  exploration: [24, 60_000],
  retry: [8, 20_000],
  'long-output': [4, 45_000],
  'all-needed': [5, 8_000],
  large: [60, 250_000],
}

/**
 * What a size may stray from the figure above.
 */
const SIZE_SLACK = 0.15

/**
 * The longest result a `truncate` leaves whole at the default settings: the
 * head of 300 characters and the 120 the note replacing the rest may take.
 */
const LEFT_WHOLE_CHARS = 420

/**
 * Strings that would mean a credential, or a fixture's stand-in for one,
 * reached the corpus.
 */
const CREDENTIAL_SHAPES: readonly string[] = [
  'sk-',
  'Bearer ',
  ...Object.values(ENV),
  ...Object.values(ADDED_ENV),
]

/**
 * Every string a scenario would put in front of a provider or the
 * assistant: message texts, tool inputs, results and their copies.
 */
function textsOf(messages: readonly SessionMessage[]): string[] {
  return messages.flatMap(message => [
    message.text,
    ...message.toolUses.flatMap(use => [
      JSON.stringify(use.input),
      use.text ?? '',
    ]),
    ...(message.toolResults ?? []).map(result => result.text),
  ])
}

function charsOf(messages: readonly SessionMessage[]): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      message.text.length +
      (message.toolResults ?? []).reduce(
        (inner, result) => inner + result.text.length,
        0,
      ),
    0,
  )
}

/**
 * Says whether a message is something the person typed.
 */
function isPrompt(message: SessionMessage): boolean {
  return (
    message.role === 'user' &&
    (message.toolResults?.length ?? 0) === 0 &&
    message.text.trim() !== ''
  )
}

/**
 * The paths an exploration's conclusion names: the assistant message just
 * before the newest prompt, its paths written in backticks.
 */
function concludedPathsOf(scenario: Scenario): string[] {
  const { messages } = scenario
  const prompt = messages.findLastIndex(isPrompt)
  const conclusion = messages[prompt - 1]

  if (
    conclusion === undefined ||
    conclusion.role !== 'assistant' ||
    conclusion.toolUses.length > 0
  ) {
    return []
  }

  return [...conclusion.text.matchAll(/`([^`\s]+\/[^`\s]+\.[a-z]+)`/g)].map(
    match => match[1] ?? '',
  )
}

describe('bench corpus', () => {
  test('success: the scenarios are the six sized above, in order', () => {
    expect(SCENARIOS.map(scenario => scenario.id)).toEqual(Object.keys(SIZES))
  })

  test('success: a tool_use_id belongs to one scenario only', () => {
    const ids = SCENARIOS.flatMap(scenario =>
      scenario.messages.flatMap(message =>
        message.toolUses.map(use => use.tool_use_id),
      ),
    )

    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const scenario of SCENARIOS) {
    const { id, messages, expected } = scenario
    const calls = pairCalls(messages, PRESERVE_RECENT)
    const judged = calls.filter(call => !call.isPinned)

    test(`success: ${id} labels only tool_use_ids its messages hold`, () => {
      const used = new Set(
        messages.flatMap(message =>
          message.toolUses.map(use => use.tool_use_id),
        ),
      )

      expect(Object.keys(expected).filter(key => !used.has(key))).toEqual([])
    })

    test(`success: ${id} labels exactly the calls that are not pinned`, () => {
      expect(Object.keys(expected).sort()).toEqual(
        judged.map(call => call.toolUseId).sort(),
      )
    })

    test(`success: ${id} labels are non-empty sets of actions`, () => {
      for (const [key, label] of Object.entries(expected)) {
        expect([key, label.length > 0]).toEqual([key, true])
        expect([key, new Set(label).size]).toEqual([key, label.length])

        for (const action of label) {
          expect(['keep', 'truncate', 'drop']).toContain(action)
        }
      }
    })

    test(`success: ${id} labels keep alone only where a truncate would cut`, () => {
      const short = judged
        .filter(call => {
          const label = expected[call.toolUseId] ?? []

          return (
            label.length === 1 &&
            label[0] === 'keep' &&
            call.resultChars <= LEFT_WHOLE_CHARS
          )
        })
        .map(call => call.toolUseId)

      expect(short).toEqual([])
    })

    test(`success: ${id} carries nothing shaped like a credential`, () => {
      const found = textsOf(messages).flatMap(text =>
        CREDENTIAL_SHAPES.filter(shape => text.includes(shape)),
      )

      expect(found).toEqual([])
    })

    test(`success: ${id} has the calls and about the characters SIZES gives`, () => {
      const [count, chars] = SIZES[id] ?? [0, 0]
      const size = charsOf(messages)

      expect(calls.length).toBe(count)
      expect(size).toBeGreaterThanOrEqual(chars * (1 - SIZE_SLACK))
      expect(size).toBeLessThanOrEqual(chars * (1 + SIZE_SLACK))
    })
  }

  test('success: large has 60 calls, 56 of them judged', () => {
    const large = scenarioOf('large')
    const calls = pairCalls(large?.messages ?? [], PRESERVE_RECENT)

    expect(calls.length).toBe(60)
    expect(calls.filter(call => !call.isPinned).length).toBe(56)
  })

  test('success: large puts its size in what the state carries', () => {
    const messages = scenarioOf('large')?.messages ?? []
    const judged = messages
      .filter(message => message.role === 'assistant')
      .filter(message => message.toolUses.length > 0)
      .slice(0, 56)
    const inputs = judged.flatMap(message =>
      message.toolUses.map(use => JSON.stringify(use.input).length),
    )
    const carried = messages.reduce(
      (sum, message) =>
        sum +
        message.text.length +
        message.toolUses.reduce(
          (inner, use) => inner + JSON.stringify(use.input).length,
          0,
        ),
      0,
    )

    expect(carried).toBeGreaterThan(70_000)
    expect(
      judged
        .map(message => message.text.length)
        .filter(length => length < 900 || length > 1_200),
    ).toEqual([])
    expect(inputs.filter(length => length < 80 || length > 150)).toEqual([])
  })

  /**
   * The stage the mod's own fitting reaches for a scenario, under a state
   * budget and in a route's wire format.
   */
  function stageOf(scenario: Scenario, budget: number, route: Route): Stage {
    return stateWithin(
      scenario.messages,
      pairCalls(scenario.messages, PRESERVE_RECENT),
      {
        maxStateTokens: budget,
        preserveRecentMessages: PRESERVE_RECENT,
        goal: goalOf(scenario.messages),
        wire: wireOf(route),
      },
    ).stage
  }

  test("success: large does not fit clef-flash's state budget whole", () => {
    const large = scenarioOf('large')

    expect(large).toBeDefined()

    if (large === undefined) {
      return
    }

    expect(
      stageOf(large, 14_000, routeOf('cloudflare', 'clef-flash')),
    ).not.toBe('whole')
  })

  for (const scenario of SCENARIOS.filter(each => each.id !== 'large')) {
    test(`success: ${scenario.id} fits a 27,000-token state whole`, () => {
      expect(stageOf(scenario, 27_000, routeOf('typesafe'))).toBe('whole')
    })
  }

  for (const id of ['exploration', 'large']) {
    test(`success: ${id} keeps the last read of every file its conclusion names`, () => {
      const scenario = scenarioOf(id)

      expect(scenario).toBeDefined()

      if (scenario === undefined) {
        return
      }

      const paths = concludedPathsOf(scenario)
      const calls = pairCalls(scenario.messages, PRESERVE_RECENT)

      expect(paths.length).toBeGreaterThanOrEqual(2)

      for (const path of paths) {
        const last = calls.findLast(
          call => call.tool === 'Read' && call.input.file_path === path,
        )

        expect([path, last?.isPinned]).toEqual([path, false])
        expect([path, scenario.expected[last?.toolUseId ?? '']]).toEqual([
          path,
          ['keep'],
        ])
      }
    })
  }

  test('success: scenarioOf finds every scenario by its id', () => {
    for (const scenario of SCENARIOS) {
      expect(scenarioOf(scenario.id)).toBe(scenario)
    }
  })

  test('error: scenarioOf answers undefined for an unknown id', () => {
    expect(scenarioOf('no-such-scenario')).toBeUndefined()
  })
})

/**
 * OpenRouter's listing of the models with the `decisions` output modality
 * as fetched on CATALOG_FETCHED_AT, cut to the fields the filter reads.
 */
const LISTED: readonly unknown[] = [
  {
    id: 'baseten/joey-1',
    context_length: 16384,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000001',
    },
  },
  {
    id: 'liquid/d1.1',
    context_length: 65536,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000002',
    },
  },
  {
    id: '~liquid/d1-ultra-latest',
    context_length: 32768,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.000000042',
    },
  },
  {
    id: '~liquid/d1-latest',
    context_length: 65536,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000002',
    },
  },
  {
    id: 'baseten/mammoth-1',
    context_length: 16384,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.0000001',
    },
  },
  {
    id: 'baseten/elephant-1',
    context_length: 16384,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.000000035',
    },
  },
  {
    id: 'nace-ai/drex-max',
    context_length: 262144,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000006',
    },
  },
  {
    id: 'perplexity/pplx-decider-flash-v1.2',
    context_length: 262144,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000001',
    },
  },
  {
    id: 'perplexity/pplx-decider-v1.2',
    context_length: 262144,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000002',
    },
  },
  {
    id: '~perplexity/pplx-decider-flash-latest',
    context_length: 262144,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000001',
    },
  },
  {
    id: 'respan/span-02',
    context_length: 131072,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000001',
    },
  },
  {
    id: 'liquid/d1-ultra',
    context_length: 32768,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.000000042',
    },
  },
  {
    id: 'typesafe/jev-1.14',
    context_length: 262144,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.000000042',
    },
  },
  {
    id: '~perplexity/pplx-decider-latest',
    context_length: 262144,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000002',
    },
  },
  {
    id: 'scaledown/classify-1',
    context_length: 1000000,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000004',
    },
  },
  {
    id: 'nace-ai/drex-v2.0',
    context_length: 131072,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000006',
    },
  },
  {
    id: 'microsoft/microsoft-decision-1',
    context_length: 32768,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.000000042',
    },
  },
  {
    id: 'nace-ai/drex-v1.5',
    context_length: 131072,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000004',
    },
  },
  {
    id: 'cloudflare/clef-omni',
    context_length: 65536,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000015',
    },
  },
  {
    id: 'upstage/solar-decide-flash',
    context_length: 524288,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000005',
    },
  },
  {
    id: 'openai/gpt-6-luna-decisions',
    context_length: 1050000,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.0000001',
    },
  },
  {
    id: 'liquid/d1',
    context_length: 65536,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000002',
    },
  },
  {
    id: 'cloudflare/clef-flash',
    context_length: 24576,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.000000038',
    },
  },
  {
    id: 'cloudflare/clef',
    context_length: 65537,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000024',
    },
  },
  {
    id: 'togethercomputer/tev1-4b-experimental',
    context_length: 32768,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.000000042',
    },
  },
  {
    id: 'inception/mercury-decide',
    context_length: 65536,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000002',
    },
  },
  {
    id: 'upstage/solar-decide',
    context_length: 524288,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000005',
    },
  },
  {
    id: 'respan/span-01',
    context_length: 0,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.00000002',
    },
  },
  {
    id: 'respan/span-01-lite',
    context_length: 0,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0',
    },
  },
  {
    id: 'respan/span-01-lite:free',
    context_length: 0,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0',
    },
  },
  {
    id: 'jaredpalmer/kev-4b',
    context_length: 8192,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.000000042',
    },
  },
  {
    id: '~typesafe/jev-latest',
    context_length: 262144,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.000000042',
    },
  },
  {
    id: 'typesafe/jev-1.13',
    context_length: 262144,
    architecture: {
      output_modalities: ['decisions'],
    },
    pricing: {
      prompt: '0.000000042',
    },
  },
]

/**
 * The listing as the filter may meet it: the models above, one of a direct
 * vendor OpenRouter did not list that day, one that only writes text, and
 * three each missing a field the filter needs.
 */
const EXCERPT = {
  data: [
    ...LISTED,
    {
      id: 'codiv/openjev-0.1',
      context_length: 32_768,
      architecture: { output_modalities: ['decisions'] },
      pricing: { prompt: '0.00000001' },
    },
    {
      id: 'example/text-model',
      context_length: 131_072,
      architecture: { output_modalities: ['text'] },
      pricing: { prompt: '0.0000001' },
    },
    {
      id: 'example/no-pricing',
      context_length: 16_384,
      architecture: { output_modalities: ['decisions'] },
    },
    {
      id: 'example/no-window',
      architecture: { output_modalities: ['decisions'] },
      pricing: { prompt: '0.00000002' },
    },
    {
      id: 'example/unreadable-price',
      context_length: 16_384,
      architecture: { output_modalities: ['decisions'] },
      pricing: { prompt: 'n/a' },
    },
  ],
}

function entryOf(id: string, contextLength: number): CatalogEntry {
  return { id, vendor: vendorOf(id), contextLength, promptPricePerToken: 0 }
}

describe('openrouter catalog', () => {
  const vendors: Record<string, [string, string]> = {
    'success: the vendor is the part before the slash': [
      'baseten/joey-1',
      'baseten',
    ],
    'success: an alias loses its tilde': ['~liquid/d1-latest', 'liquid'],
    'success: a variant suffix stays with the model': [
      'respan/span-01-lite:free',
      'respan',
    ],
    'success: an id without a slash is its own vendor': ['solo', 'solo'],
  }

  for (const [name, [id, vendor]] of Object.entries(vendors)) {
    test(name, () => {
      expect(vendorOf(id)).toBe(vendor)
    })
  }

  test('success: the static table is the filter over the saved listing', () => {
    expect(openrouterOnlyOf(EXCERPT).map(entry => entry.id)).toEqual(
      OPENROUTER_CATALOG.map(entry => entry.id),
    )
    expect(openrouterOnlyOf(EXCERPT)).toEqual(OPENROUTER_CATALOG)
  })

  test('success: the static table holds the twenty OpenRouter-only models', () => {
    expect(OPENROUTER_CATALOG.length).toBe(20)
    expect(CATALOG_FETCHED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    for (const entry of OPENROUTER_CATALOG) {
      expect(entry.vendor).toBe(vendorOf(entry.id))
    }
  })

  test('success: the direct vendors and the aliases are filtered out', () => {
    const ids = openrouterOnlyOf(EXCERPT).map(entry => entry.id)

    expect(ids.filter(id => id.startsWith('~'))).toEqual([])
    expect(ids.filter(id => DIRECT_VENDORS.includes(vendorOf(id)))).toEqual([])
    expect([...DIRECT_VENDORS].sort()).toEqual([
      'cloudflare',
      'codiv',
      'openai',
      'perplexity',
      'typesafe',
    ])
  })

  test('success: a window the listing does not state reads as 0', () => {
    const span = openrouterOnlyOf(EXCERPT).find(
      entry => entry.id === 'respan/span-01',
    )

    expect(span).toEqual({
      id: 'respan/span-01',
      vendor: 'respan',
      contextLength: 0,
      promptPricePerToken: 0.00000002,
    })
  })

  test('success: the result is sorted by id whatever the listing order', () => {
    const reversed = { data: [...EXCERPT.data].reverse() }

    expect(openrouterOnlyOf(reversed)).toEqual(OPENROUTER_CATALOG)
  })

  test('error: an entry missing a field it needs is skipped', () => {
    const ids = openrouterOnlyOf(EXCERPT).map(entry => entry.id)

    expect(ids.filter(id => id.startsWith('example/'))).toEqual([])
  })

  /**
   * One listed model that passes the filter, with `over` replacing any of
   * its fields.
   */
  const listedWith = (over: Record<string, unknown>) => ({
    id: 'example/decide-1',
    context_length: 16_384,
    architecture: { output_modalities: ['decisions'] },
    pricing: { prompt: '0.00000002' },
    ...over,
  })

  test('success: the model the malformed ones are made from passes the filter', () => {
    expect(openrouterOnlyOf({ data: [listedWith({})] })).toEqual([
      {
        id: 'example/decide-1',
        vendor: 'example',
        contextLength: 16_384,
        promptPricePerToken: 0.00000002,
      },
    ])
  })

  const malformed: Record<string, Record<string, unknown>> = {
    'error: an empty id is skipped': { id: '' },
    'error: an id of only whitespace is skipped': { id: ' \t\n' },
    'error: a negative window is skipped': { context_length: -1 },
    'error: an infinite window is skipped': {
      context_length: Number.POSITIVE_INFINITY,
    },
    'error: a window that is not a number is skipped': {
      context_length: Number.NaN,
    },
    'error: a negative price is skipped': {
      pricing: { prompt: '-0.00000002' },
    },
    'error: an infinite price is skipped': { pricing: { prompt: 'Infinity' } },
    'error: a price that is not a number is skipped': {
      pricing: { prompt: 'NaN' },
    },
  }

  for (const [name, over] of Object.entries(malformed)) {
    test(name, () => {
      const listing = { data: [listedWith(over), ...EXCERPT.data] }

      expect(openrouterOnlyOf(listing)).toEqual(OPENROUTER_CATALOG)
    })
  }

  const listings: Record<string, unknown> = {
    'error: a listing that is not an object holds nothing': 'models',
    'error: a listing without a data list holds nothing': { data: {} },
    'error: an empty listing holds nothing': { data: [] },
    'error: entries that are not objects are skipped': {
      data: [null, 'baseten/joey-1', 42],
    },
  }

  for (const [name, listing] of Object.entries(listings)) {
    test(name, () => {
      expect(openrouterOnlyOf(listing)).toEqual([])
    })
  }

  const budgets: Record<string, [number, number | undefined]> = {
    'success: an 8,192-token window becomes both budgets': [8_192, 8_192],
    'success: a 16,384-token window becomes both budgets': [16_384, 16_384],
    'success: a window just under the assumed one becomes the budgets': [
      31_999, 31_999,
    ],
    'success: a window equal to the assumed one needs no budget': [
      32_000,
      undefined,
    ],
    'success: a 65,536-token window needs no budget': [65_536, undefined],
    'success: a window the listing does not state needs no budget': [
      0,
      undefined,
    ],
  }

  for (const [name, [window, budget]] of Object.entries(budgets)) {
    test(name, () => {
      expect(budgetOverrideOf(entryOf('example/model', window))).toEqual(
        budget === undefined
          ? undefined
          : { maxStateTokens: budget, maxRequestTokens: budget },
      )
    })
  }

  test('success: only the Baseten models and Kev get budgets', () => {
    expect(
      OPENROUTER_CATALOG.filter(
        entry => budgetOverrideOf(entry) !== undefined,
      ).map(entry => entry.id),
    ).toEqual([
      'baseten/elephant-1',
      'baseten/joey-1',
      'baseten/mammoth-1',
      'jaredpalmer/kev-4b',
    ])
  })
})
