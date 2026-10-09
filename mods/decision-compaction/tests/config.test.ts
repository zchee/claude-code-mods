import type { PluginOptions } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { configOf, eligibleOf } from '../hooks/config'
import { PROVIDERS } from '../hooks/providers'

const NONE_OF =
  'typesafe, cloudflare, openrouter, codiv, perplexity, ' +
  'decisions-api-dev, decisionapi-net, openai'

describe('configOf', () => {
  test('success: unset options read as the documented defaults', () => {
    expect(configOf({})).toEqual({
      provider: 'typesafe',
      providerDecision: false,
      decisionProviders: PROVIDERS,
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      maxStateTokens: 25000,
      maxRequestTokens: 30000,
      truncateHeadChars: 300,
    })
  })

  test('success: set options are taken as given', () => {
    expect(
      configOf({
        provider: 'cloudflare',
        model: ' clef-flash ',
        providerDecision: true,
        keepThreshold: 0.8,
        preserveRecentMessages: 10,
        compactAtPercent: 0,
        minReductionRatio: 0.1,
        maxStateTokens: 40000,
        maxRequestTokens: 50000,
        truncateHeadChars: 0,
      }),
    ).toEqual({
      provider: 'cloudflare',
      model: 'clef-flash',
      providerDecision: true,
      decisionProviders: PROVIDERS,
      keepThreshold: 0.8,
      preserveRecentMessages: 10,
      compactAtPercent: 0,
      minReductionRatio: 0.1,
      maxStateTokens: 40000,
      maxRequestTokens: 50000,
      truncateHeadChars: 0,
    })
  })

  const repaired: Record<
    string,
    { options: Record<string, string | number | boolean>; expected: object }
  > = {
    'error: a threshold above 1 is held to 1': {
      options: { keepThreshold: 7 },
      expected: { keepThreshold: 1 },
    },
    'error: a negative count is held to 0': {
      options: { preserveRecentMessages: -3, truncateHeadChars: -1 },
      expected: { preserveRecentMessages: 0, truncateHeadChars: 0 },
    },
    'error: a fractional count is rounded down': {
      options: { preserveRecentMessages: 4.9 },
      expected: { preserveRecentMessages: 4 },
    },
    'error: a number typed as text reads as the default': {
      options: { maxStateTokens: '9000', compactAtPercent: 'high' },
      expected: { maxStateTokens: 25000, compactAtPercent: 60 },
    },
    'error: a percent above 100 is held to 100': {
      options: { compactAtPercent: 250 },
      expected: { compactAtPercent: 100 },
    },
    'error: a budget of zero is held to one token': {
      options: { maxStateTokens: 0, maxRequestTokens: -5 },
      expected: { maxStateTokens: 1, maxRequestTokens: 1 },
    },
    'error: a fractional budget is rounded down': {
      options: { maxStateTokens: 20000.7, maxRequestTokens: 0.5 },
      expected: { maxStateTokens: 20000, maxRequestTokens: 1 },
    },
    'error: only a true boolean turns the provider decision on': {
      options: { providerDecision: 'true' },
      expected: { providerDecision: false },
    },
  }

  for (const [name, { options, expected }] of Object.entries(repaired)) {
    test(name, () => {
      expect(configOf(options)).toMatchObject(expected)
    })
  }

  const refused: Record<string, { provider: string | number; reason: string }> =
    {
      'error: a misspelt provider is refused, not replaced': {
        provider: 'cloud-flare',
        reason:
          `the provider option is "cloud-flare", which is none of ` + NONE_OF,
      },
      'error: a provider of another kind is refused': {
        provider: 'typellm',
        reason: `the provider option is "typellm", which is none of ${NONE_OF}`,
      },
      'error: a provider given as a number is refused': {
        provider: 3,
        reason: `the provider option is 3, which is none of ${NONE_OF}`,
      },
      'error: a provider named in another case is refused': {
        provider: 'TypeSafe',
        reason:
          `the provider option is "TypeSafe", which is none of ` + NONE_OF,
      },
      'error: a very long value is quoted only in part': {
        provider: 'x'.repeat(400),
        reason:
          `the provider option is "${'x'.repeat(159)}…, which is none of ` +
          NONE_OF,
      },
    }

  for (const [name, { provider, reason }] of Object.entries(refused)) {
    test(name, () => {
      expect(configOf({ provider }).refusal).toBe(reason)
    })
  }

  const unset: Record<string, Record<string, string>> = {
    'success: an absent provider is the default, without a refusal': {},
    'success: an empty provider is the default, without a refusal': {
      provider: '',
    },
    'success: a blank provider is the default, without a refusal': {
      provider: '   ',
    },
  }

  for (const [name, options] of Object.entries(unset)) {
    test(name, () => {
      const config = configOf(options)

      expect(config.provider).toBe('typesafe')
      expect('refusal' in config).toBe(false)
    })
  }

  test('success: a blank model is no model', () => {
    expect('model' in configOf({ model: '   ' })).toBe(false)
  })
})

describe('decisionProviders', () => {
  const parsed: Record<
    string,
    {
      value?: PluginOptions[string]
      named: readonly string[]
      unknown?: string[]
    }
  > = {
    'success: unset, every provider may be picked': { named: PROVIDERS },
    'success: a cleared field names no provider': { value: '', named: [] },
    'success: a field of white space names no provider': {
      value: '  ',
      named: [],
    },
    'success: a field of commas names no provider': { value: ',', named: [] },
    'success: names separated by commas are read in the providers order': {
      value: ' openrouter , typesafe,cloudflare ',
      named: ['typesafe', 'cloudflare', 'openrouter'],
    },
    'success: a list is read as the same names': {
      value: ['openai', 'decisions-api-dev'],
      named: ['decisions-api-dev', 'openai'],
    },
    'error: an unknown name is dropped and kept to be reported': {
      value: 'typesafe,typellm,nope,typellm',
      named: ['typesafe'],
      unknown: ['typellm', 'nope'],
    },
    'error: a name in another case is no provider': {
      value: 'OpenAI',
      named: [],
      unknown: ['OpenAI'],
    },
    'error: a value of another type names no provider': {
      value: 3,
      named: [],
      unknown: ['3'],
    },
    'error: an empty list names no provider': { value: [], named: [] },
  }

  for (const [name, { value, named, unknown }] of Object.entries(parsed)) {
    test(name, () => {
      const config = configOf({
        providerDecision: true,
        ...(value === undefined ? {} : { decisionProviders: value }),
      })

      expect(config.decisionProviders).toEqual(named)
      expect(config.unknownProviders).toEqual(unknown)
      expect(config.refusal, 'a name dropped refuses nothing').toBeUndefined()
    })
  }
})

describe('eligibleOf', () => {
  const eligible: Record<
    string,
    { options: PluginOptions; expected: string[] }
  > = {
    'success: with the decision off only the configured provider is eligible':
      {
        options: { provider: 'openai', decisionProviders: 'typesafe' },
        expected: ['openai'],
      },
    'success: with the decision on and nothing narrowed every provider is eligible':
      { options: { providerDecision: true }, expected: [...PROVIDERS] },
    'success: the configured provider is eligible though it is not listed': {
      options: {
        provider: 'openai',
        providerDecision: true,
        decisionProviders: 'cloudflare,typesafe',
      },
      expected: ['typesafe', 'cloudflare', 'openai'],
    },
    'success: names that are all unknown leave the configured provider alone':
      {
        options: { providerDecision: true, decisionProviders: 'nope' },
        expected: ['typesafe'],
      },
    'success: a cleared field leaves the configured provider alone': {
      options: {
        provider: 'codiv',
        providerDecision: true,
        decisionProviders: '',
      },
      expected: ['codiv'],
    },
  }

  for (const [name, { options, expected }] of Object.entries(eligible)) {
    test(name, () => {
      expect(eligibleOf(configOf(options))).toEqual(expected)
    })
  }
})
