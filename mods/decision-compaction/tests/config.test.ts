import { describe, expect, test } from 'claude-code/testing'

import { configOf } from '../hooks/config'

describe('configOf', () => {
  test('success: unset options read as the documented defaults', () => {
    expect(configOf({})).toEqual({
      provider: 'typesafe',
      providerDecision: false,
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
          'the provider option is "cloud-flare", which is none of ' +
          'typesafe, cloudflare, openrouter',
      },
      'error: a provider of another kind is refused': {
        provider: 'openai',
        reason:
          'the provider option is "openai", which is none of ' +
          'typesafe, cloudflare, openrouter',
      },
      'error: a provider given as a number is refused': {
        provider: 3,
        reason:
          'the provider option is 3, which is none of ' +
          'typesafe, cloudflare, openrouter',
      },
      'error: a provider named in another case is refused': {
        provider: 'TypeSafe',
        reason:
          'the provider option is "TypeSafe", which is none of ' +
          'typesafe, cloudflare, openrouter',
      },
      'error: a very long value is quoted only in part': {
        provider: 'x'.repeat(400),
        reason:
          `the provider option is "${'x'.repeat(159)}…, which is none of ` +
          'typesafe, cloudflare, openrouter',
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
