import { describe, expect, test } from 'claude-code/testing'

import type { Ask } from '../hooks/compact'
import { PROVIDERS } from '../hooks/providers'
import type { Credentials, ProviderName, Route } from '../hooks/providers'
import {
  candidatesOf,
  chooseRoute,
  profileOf,
} from '../hooks/route'
import type { Profile } from '../hooks/route'
import { pairCalls } from '../hooks/state'
import type { Questions } from '../hooks/systemone'
import { answering, calling, said, sessionOf } from './fixtures'

const TYPESAFE: Route = { provider: 'typesafe', model: 'jev-latest' }
const OPENROUTER: Route = {
  provider: 'openrouter',
  model: '~typesafe/jev-latest',
}
const CLEF: Route = { provider: 'cloudflare', model: 'clef' }
const CLEF_FLASH: Route = { provider: 'cloudflare', model: 'clef-flash' }

const TYPESAFE_KEY: Credentials = { typesafeApiKey: 'test-typesafe-key' }
const OPENROUTER_KEY: Credentials = { openrouterApiKey: 'test-openrouter-key' }
const CLOUDFLARE_KEYS: Credentials = {
  cloudflareApiToken: 'test-cloudflare-token',
  cloudflareAccountId: 'test-account',
}

const FITS = () => undefined

/**
 * Three providers that between them meet every rule of the choice: a direct
 * route and a gateway to the same Jev, and a provider with two models.
 * Narrowed to them, the candidates and refusals a test expects stay short.
 */
const ORIGINAL: readonly ProviderName[] = [
  'typesafe',
  'cloudflare',
  'openrouter',
]

const PROFILE: Profile = {
  context: 'c',
  goal: 'g',
  messages: 11,
  candidate_calls: 3,
  state_tokens: 900,
  tools: { Read: 1 },
  error_share: 0,
  non_ascii_share: 0,
}

/**
 * A fake of the routing request: keeps the route it was asked on and what it
 * was asked, and answers the given pick.
 */
function askingFor(pick: string | Error) {
  const asked: { route: Route; state: unknown; questions: Questions }[] = []
  const askOn =
    (route: Route): Ask =>
    async (state, questions) => {
      asked.push({ route, state, questions })

      if (pick instanceof Error) {
        throw pick
      }

      return {
        answers: {
          route: { type: 'choice', choice: pick, confidence: 0.81 },
        },
        usage: {},
      }
    }

  return { asked, askOn }
}

describe('candidatesOf', () => {
  const offered: Record<
    string,
    {
      configured: Route
      credentials: Credentials
      keys: string[]
      refused: string[]
      usable: boolean
    }
  > = {
    'success: one key gives one candidate': {
      configured: TYPESAFE,
      credentials: TYPESAFE_KEY,
      keys: ['typesafe.jev-latest'],
      refused: [
        'cloudflare/clef: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        'cloudflare/clef-flash: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        'openrouter/~typesafe/jev-latest: OPENROUTER_API_KEY unset',
      ],
      usable: true,
    },
    'success: cloudflare offers both of its models': {
      configured: CLEF,
      credentials: CLOUDFLARE_KEYS,
      keys: ['cloudflare.clef', 'cloudflare.clef-flash'],
      refused: [
        'typesafe/jev-latest: TYPESAFE_API_KEY unset',
        'openrouter/~typesafe/jev-latest: OPENROUTER_API_KEY unset',
      ],
      usable: true,
    },
    'success: the gateway to a model reached directly is left out': {
      configured: OPENROUTER,
      credentials: { ...TYPESAFE_KEY, ...OPENROUTER_KEY },
      keys: ['typesafe.jev-latest'],
      refused: [
        'cloudflare/clef: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        'cloudflare/clef-flash: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        'openrouter/~typesafe/jev-latest: the same model as typesafe/jev-latest',
      ],
      usable: true,
    },
    'success: the gateway stands when it is the only way to the model': {
      configured: CLEF,
      credentials: { ...CLOUDFLARE_KEYS, ...OPENROUTER_KEY },
      keys: [
        'cloudflare.clef',
        'cloudflare.clef-flash',
        'openrouter.-typesafe-jev-latest',
      ],
      refused: ['typesafe/jev-latest: TYPESAFE_API_KEY unset'],
      usable: true,
    },
    'success: a bare jev id on the gateway is the model typesafe serves': {
      configured: { provider: 'openrouter', model: 'jev-1.13' },
      credentials: { ...TYPESAFE_KEY, ...OPENROUTER_KEY, ...CLOUDFLARE_KEYS },
      keys: ['typesafe.jev-latest', 'cloudflare.clef', 'cloudflare.clef-flash'],
      refused: ['openrouter/jev-1.13: the same model as typesafe/jev-latest'],
      usable: true,
    },
    'success: the pinned gateway id of jev is the model typesafe serves': {
      configured: { provider: 'openrouter', model: 'typesafe/jev-1.13' },
      credentials: { ...TYPESAFE_KEY, ...OPENROUTER_KEY, ...CLOUDFLARE_KEYS },
      keys: ['typesafe.jev-latest', 'cloudflare.clef', 'cloudflare.clef-flash'],
      refused: [
        'openrouter/typesafe/jev-1.13: the same model as typesafe/jev-latest',
      ],
      usable: true,
    },
    'success: another model on the gateway is offered beside jev': {
      configured: { provider: 'openrouter', model: 'acme/decider-1' },
      credentials: { ...TYPESAFE_KEY, ...OPENROUTER_KEY },
      keys: ['typesafe.jev-latest', 'openrouter.acme-decider-1'],
      refused: [
        'cloudflare/clef: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        'cloudflare/clef-flash: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
      ],
      usable: true,
    },
    'success: a model of typesafe on the gateway that is not jev is offered beside jev':
      {
        configured: { provider: 'openrouter', model: 'typesafe/decider-2' },
        credentials: { ...TYPESAFE_KEY, ...OPENROUTER_KEY },
        keys: ['typesafe.jev-latest', 'openrouter.typesafe-decider-2'],
        refused: [
          'cloudflare/clef: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
          'cloudflare/clef-flash: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        ],
        usable: true,
      },
    'success: a name that only begins like jev is not jev': {
      configured: { provider: 'openrouter', model: '~typesafe/jevons-1' },
      credentials: { ...TYPESAFE_KEY, ...OPENROUTER_KEY },
      keys: ['typesafe.jev-latest', 'openrouter.-typesafe-jevons-1'],
      refused: [
        'cloudflare/clef: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        'cloudflare/clef-flash: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
      ],
      usable: true,
    },
    'success: the bare family name on the gateway is jev': {
      configured: { provider: 'openrouter', model: 'typesafe/jev' },
      credentials: { ...TYPESAFE_KEY, ...OPENROUTER_KEY },
      keys: ['typesafe.jev-latest'],
      refused: [
        'cloudflare/clef: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        'cloudflare/clef-flash: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        'openrouter/typesafe/jev: the same model as typesafe/jev-latest',
      ],
      usable: true,
    },
    'success: the configured model is the one offered for its provider': {
      configured: { provider: 'typesafe', model: 'jev-1.13.0' },
      credentials: { ...TYPESAFE_KEY, ...CLOUDFLARE_KEYS },
      keys: ['typesafe.jev-1.13.0', 'cloudflare.clef', 'cloudflare.clef-flash'],
      refused: ['openrouter/~typesafe/jev-latest: OPENROUTER_API_KEY unset'],
      usable: true,
    },
    'error: no key gives no candidate': {
      configured: TYPESAFE,
      credentials: {},
      keys: [],
      refused: [
        'typesafe/jev-latest: TYPESAFE_API_KEY unset',
        'cloudflare/clef: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        'cloudflare/clef-flash: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset',
        'openrouter/~typesafe/jev-latest: OPENROUTER_API_KEY unset',
      ],
      usable: false,
    },
  }

  for (const [
    name,
    { configured, credentials, keys, refused, usable },
  ] of Object.entries(offered)) {
    test(name, () => {
      const found = candidatesOf(configured, ORIGINAL, credentials, FITS)

      expect(found.candidates.map(candidate => candidate.key)).toEqual(keys)
      expect(found.refused).toEqual(refused)
      expect(found.isConfiguredUsable).toBe(usable)
    })
  }

  test('success: a route the state does not fit is left out with the reason', () => {
    const found = candidatesOf(
      TYPESAFE,
      ORIGINAL,
      { ...TYPESAFE_KEY, ...CLOUDFLARE_KEYS },
      route =>
        route.provider === 'typesafe'
          ? 'the state is about 40000 tokens and it takes 31960'
          : undefined,
    )

    expect(found.candidates.map(candidate => candidate.route)).toEqual([
      CLEF,
      CLEF_FLASH,
    ])
    expect(found.refused).toContain(
      'typesafe/jev-latest: the state is about 40000 tokens and it takes 31960',
    )
    expect(found.isConfiguredUsable).toBe(false)
  })

  test('success: each candidate is described by what is documented about its model', () => {
    const { candidates } = candidatesOf(
      CLEF,
      ORIGINAL,
      { ...CLOUDFLARE_KEYS, ...OPENROUTER_KEY },
      FITS,
    )
    const about = Object.fromEntries(
      candidates.map(candidate => [candidate.key, candidate.about]),
    )

    expect(about['cloudflare.clef']).toContain('highest-precision')
    expect(about['cloudflare.clef-flash']).toContain('latency-critical')
    expect(about['openrouter.-typesafe-jev-latest']).toContain(
      "TypeSafe's flagship",
    )
    expect(about['openrouter.-typesafe-jev-latest']).toContain(
      'English is its primary training language',
    )
    expect(
      about['openrouter.-typesafe-jev-latest']?.endsWith(
        'Reached through OpenRouter.',
      ),
    ).toBe(true)
  })

  test('success: a bare jev id on the gateway is described as jev', () => {
    const { candidates } = candidatesOf(
      { provider: 'openrouter', model: 'jev-latest' },
      ORIGINAL,
      OPENROUTER_KEY,
      FITS,
    )

    expect(candidates.map(candidate => candidate.key)).toEqual([
      'openrouter.jev-latest',
    ])
    expect(candidates[0]?.about).toContain("TypeSafe's flagship")
    expect(candidates[0]?.about.includes('nothing is documented')).toBe(false)
  })
})

describe('profileOf', () => {
  test('success: the profile counts the job and holds no message text', () => {
    const messages = sessionOf()
    const candidates = pairCalls(messages, 2).filter(call => !call.isPinned)
    const profile = profileOf(messages, candidates, 1500, 'fix the test')

    expect(profile).toEqual({
      context: profile.context,
      goal: 'fix the test',
      messages: 11,
      candidate_calls: 3,
      state_tokens: 1500,
      tools: { Read: 1, Bash: 1, Grep: 1 },
      error_share: 0.33,
      non_ascii_share: 0,
    })
    expect(JSON.stringify(profile).includes('Fix the failing test')).toBe(false)
    expect(JSON.stringify(profile).length < 1500).toBe(true)
  })

  test('success: the tool mix names the eight most used and counts the rest together', () => {
    const uses = Array.from(
      { length: 10 },
      (_, index) => [`u${index}`, `Tool${index}`, {}] as const,
    )
    const messages = [
      said('go'),
      calling('', [...uses, ['x1', 'Tool0', {}], ['x2', 'Tool0', {}]]),
      answering([
        ...uses.map(([id]) => [id, 'r'] as const),
        ['x1', 'r'],
        ['x2', 'r'],
      ]),
      said('日本語のテキスト'),
    ]
    const profile = profileOf(
      messages,
      pairCalls(messages, 0).filter(call => !call.isPinned),
      10,
      '',
    )

    expect(profile.tools).toEqual({
      Tool0: 3,
      Tool1: 1,
      Tool2: 1,
      Tool3: 1,
      Tool4: 1,
      Tool5: 1,
      Tool6: 1,
      Tool7: 1,
      other: 2,
    })
    expect(profile.candidate_calls).toBe(12)
    expect(profile.non_ascii_share).toBe(0.8)
  })
})

describe('chooseRoute', () => {
  test('success: with one candidate nothing is asked and the configured route is used', async () => {
    const { asked, askOn } = askingFor('unused')
    const routed = await chooseRoute(
      TYPESAFE,
      ORIGINAL,
      TYPESAFE_KEY,
      FITS,
      PROFILE,
      askOn,
    )

    expect(asked).toEqual([])
    expect(routed.route).toEqual(TYPESAFE)
    expect(routed.why.startsWith('one route is available (')).toBe(true)
    expect(
      routed.why.endsWith('; using the configured typesafe/jev-latest'),
    ).toBe(true)
  })

  test('error: with no candidate nothing is asked, and the refusal names why each route was ruled out', async () => {
    const { asked, askOn } = askingFor('unused')

    await expect(
      chooseRoute(
        TYPESAFE,
        ORIGINAL,
        CLOUDFLARE_KEYS,
        route =>
          route.provider === 'cloudflare'
            ? 'the state is about 70000 tokens and it takes 55705'
            : undefined,
        PROFILE,
        askOn,
      ),
    ).rejects.toThrow({
      message:
        'no route can take this job: ' +
        'typesafe/jev-latest: TYPESAFE_API_KEY unset; ' +
        'cloudflare/clef: the state is about 70000 tokens and it takes 55705; ' +
        'cloudflare/clef-flash: the state is about 70000 tokens and it takes 55705; ' +
        'openrouter/~typesafe/jev-latest: OPENROUTER_API_KEY unset',
    })
    expect(asked).toEqual([])
  })

  test('success: the configured gateway is kept when the direct route is the one candidate', async () => {
    const { asked, askOn } = askingFor('unused')
    const routed = await chooseRoute(
      OPENROUTER,
      ORIGINAL,
      { ...TYPESAFE_KEY, ...OPENROUTER_KEY },
      FITS,
      PROFILE,
      askOn,
    )

    expect(asked).toEqual([])
    expect(routed).toEqual({
      route: OPENROUTER,
      why:
        'one model is available (cloudflare/clef: CLOUDFLARE_API_TOKEN and ' +
        'CLOUDFLARE_ACCOUNT_ID unset; cloudflare/clef-flash: ' +
        'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; ' +
        'openrouter/~typesafe/jev-latest: the same model as ' +
        'typesafe/jev-latest); using the configured ' +
        'openrouter/~typesafe/jev-latest',
    })
    expect(
      routed.why.includes('reached directly'),
      'the route in use is not described as left out',
    ).toBe(false)
  })

  test('success: a configured route that cannot take the job gives way to the one that can', async () => {
    const { asked, askOn } = askingFor('unused')
    const routed = await chooseRoute(
      TYPESAFE,
      ORIGINAL,
      OPENROUTER_KEY,
      FITS,
      PROFILE,
      askOn,
    )

    expect(asked).toEqual([])
    expect(routed.route).toEqual(OPENROUTER)
    expect(
      routed.why.startsWith(
        'only openrouter/~typesafe/jev-latest can take this job (',
      ),
    ).toBe(true)
  })

  test('success: several candidates are put to clef-flash as one choice over the profile', async () => {
    const { asked, askOn } = askingFor('cloudflare.clef')
    const routed = await chooseRoute(
      TYPESAFE,
      ORIGINAL,
      { ...TYPESAFE_KEY, ...CLOUDFLARE_KEYS },
      FITS,
      PROFILE,
      askOn,
    )

    expect(asked).toHaveLength(1)
    expect(asked[0]?.route, 'asked on the fastest route').toEqual(CLEF_FLASH)
    expect(asked[0]?.state, 'the profile, not the conversation').toBe(PROFILE)
    expect(Object.keys(asked[0]?.questions ?? {})).toEqual(['route'])
    expect(asked[0]?.questions.route?.type).toBe('choice')
    expect(Object.keys(asked[0]?.questions.route?.criteria ?? {})).toEqual([
      'typesafe.jev-latest',
      'cloudflare.clef',
      'cloudflare.clef-flash',
    ])
    expect(routed).toEqual({
      route: CLEF,
      why: 'cloudflare/clef-flash picked cloudflare/clef, confidence 0.81',
    })
  })

  test('success: the pick may be the configured route itself', async () => {
    const { askOn } = askingFor('typesafe.jev-latest')
    const routed = await chooseRoute(
      TYPESAFE,
      ORIGINAL,
      { ...TYPESAFE_KEY, ...CLOUDFLARE_KEYS },
      FITS,
      PROFILE,
      askOn,
    )

    expect(routed.route).toEqual(TYPESAFE)
  })

  const failing: Record<string, { pick: string | Error; reason: string }> = {
    'error: a failed routing request falls back to the configured route': {
      pick: new Error('cloudflare answered HTTP 429: slow down'),
      reason: 'cloudflare answered HTTP 429: slow down',
    },
    'error: a failed routing request is quoted on one short line without control characters or a key':
      {
        pick: new Error(
          'cloudflare answered HTTP 500: \u001b[2J' +
            `${CLOUDFLARE_KEYS.cloudflareApiToken ?? ''}\n${'z'.repeat(400)}`,
        ),
        reason: `cloudflare answered HTTP 500: [2J[redacted] ${'z'.repeat(116)}…`,
      },
    'error: a pick outside the candidates falls back to the configured route': {
      pick: 'openai.gpt',
      reason: 'no offered option was answered for route',
    },
  }

  for (const [name, { pick, reason }] of Object.entries(failing)) {
    test(name, async () => {
      const { asked, askOn } = askingFor(pick)
      const routed = await chooseRoute(
        TYPESAFE,
        ORIGINAL,
        { ...TYPESAFE_KEY, ...CLOUDFLARE_KEYS },
        FITS,
        PROFILE,
        askOn,
      )

      expect(asked).toHaveLength(1)
      expect(routed).toEqual({
        route: TYPESAFE,
        why: `the routing request failed (${reason}); using the configured typesafe/jev-latest`,
      })
    })
  }
})

const ADDED_KEYS: Credentials = {
  codivApiKey: 'test-codiv-key',
  perplexityApiKey: 'test-perplexity-key',
  decisionsApiKey: 'test-decisions-key',
  decisionapiApiKey: 'test-decisionapi-key',
  openaiApiKey: 'test-openai-key',
}

const ALL_KEYS: Credentials = {
  ...TYPESAFE_KEY,
  ...OPENROUTER_KEY,
  ...CLOUDFLARE_KEYS,
  ...ADDED_KEYS,
}

describe('candidatesOf, over every provider', () => {
  test('success: with every key set each model is offered once, and the jev gateways give way to typesafe', () => {
    const found = candidatesOf(TYPESAFE, PROVIDERS, ALL_KEYS, FITS)

    expect(found.candidates.map(candidate => candidate.key)).toEqual([
      'typesafe.jev-latest',
      'cloudflare.clef',
      'cloudflare.clef-flash',
      'codiv.openjev-latest',
      'perplexity.pplx-decider-v1.1-27b',
      'openai.gpt-6-luna',
    ])
    expect(found.refused).toEqual([
      'openrouter/~typesafe/jev-latest: the same model as typesafe/jev-latest',
      'decisions-api-dev/jev-latest: the same model as typesafe/jev-latest',
      'decisionapi-net/jev-latest: the same model as typesafe/jev-latest',
    ])
    expect(found.isConfiguredUsable).toBe(true)
  })

  test('success: without typesafe the first gateway to jev is the one offered', () => {
    const found = candidatesOf(
      OPENROUTER,
      ['openrouter', 'decisions-api-dev', 'decisionapi-net'],
      ALL_KEYS,
      FITS,
    )

    expect(found.candidates.map(candidate => candidate.key)).toEqual([
      'openrouter.-typesafe-jev-latest',
    ])
    expect(found.refused).toEqual([
      'decisions-api-dev/jev-latest: the same model as ' +
        'openrouter/~typesafe/jev-latest',
      'decisionapi-net/jev-latest: the same model as ' +
        'openrouter/~typesafe/jev-latest',
    ])
  })

  test('success: with typesafe among them the direct route to jev wins', () => {
    const found = candidatesOf(
      OPENROUTER,
      ['typesafe', 'openrouter', 'decisions-api-dev', 'decisionapi-net'],
      ALL_KEYS,
      FITS,
    )

    expect(found.candidates.map(candidate => candidate.key)).toEqual([
      'typesafe.jev-latest',
    ])
    expect(found.refused).toEqual([
      'openrouter/~typesafe/jev-latest: the same model as typesafe/jev-latest',
      'decisions-api-dev/jev-latest: the same model as typesafe/jev-latest',
      'decisionapi-net/jev-latest: the same model as typesafe/jev-latest',
    ])
    expect(
      found.isConfiguredUsable,
      'the configured gateway can still take the job',
    ).toBe(true)
  })

  test('success: a gateway the first is refused for gives way to the next', () => {
    const found = candidatesOf(
      { provider: 'decisionapi-net', model: 'jev-latest' },
      ['openrouter', 'decisions-api-dev', 'decisionapi-net'],
      { decisionsApiKey: 'test-decisions-key', ...ADDED_KEYS },
      FITS,
    )

    expect(found.candidates.map(candidate => candidate.key)).toEqual([
      'decisions-api-dev.jev-latest',
    ])
    expect(found.refused).toEqual([
      'openrouter/~typesafe/jev-latest: OPENROUTER_API_KEY unset',
      'decisionapi-net/jev-latest: the same model as decisions-api-dev/jev-latest',
    ])
  })

  test('success: a provider left out of the eligible ones is not considered, keys or not', () => {
    const found = candidatesOf(TYPESAFE, ['typesafe', 'openai'], ALL_KEYS, FITS)

    expect(found.candidates.map(candidate => candidate.key)).toEqual([
      'typesafe.jev-latest',
      'openai.gpt-6-luna',
    ])
    expect(found.refused).toEqual([])
  })

  test('success: a jev reseller is described as jev reached through it, a model of its own by its own line', () => {
    const { candidates } = candidatesOf(
      { provider: 'codiv', model: 'openjev-latest' },
      ['codiv', 'decisions-api-dev'],
      ALL_KEYS,
      FITS,
    )
    const about = Object.fromEntries(
      candidates.map(candidate => [candidate.key, candidate.about]),
    )

    expect(about['decisions-api-dev.jev-latest']).toContain(
      "TypeSafe's flagship",
    )
    expect(
      about['decisions-api-dev.jev-latest']?.endsWith(
        'Reached through decisions-api.dev.',
      ),
    ).toBe(true)
    expect(about['codiv.openjev-latest']).toBe(
      'OpenJev, DiffusionGemma 26B-A4B made into a System One model; it ' +
        'reads a distribution for every answer in one denoising step.',
    )
  })
})

describe('chooseRoute, over every provider', () => {
  test('success: with every provider eligible the routing question still goes to clef-flash', async () => {
    const { asked, askOn } = askingFor('openai.gpt-6-luna')
    const routed = await chooseRoute(
      TYPESAFE,
      PROVIDERS,
      ALL_KEYS,
      FITS,
      PROFILE,
      askOn,
    )

    expect(asked.map(question => question.route)).toEqual([CLEF_FLASH])
    expect(routed).toEqual({
      route: { provider: 'openai', model: 'gpt-6-luna' },
      why: 'cloudflare/clef-flash picked openai/gpt-6-luna, confidence 0.81',
    })
  })

  test('success: cloudflare left out of the eligible ones is not asked, whatever its keys', async () => {
    const { asked, askOn } = askingFor('openai.gpt-6-luna')
    const routed = await chooseRoute(
      TYPESAFE,
      ['typesafe', 'openai'],
      ALL_KEYS,
      FITS,
      PROFILE,
      askOn,
    )

    expect(
      asked.map(question => question.route),
      'the profile goes to the configured route only',
    ).toEqual([TYPESAFE])
    expect(Object.keys(asked[0]?.questions.route?.criteria ?? {})).toEqual([
      'typesafe.jev-latest',
      'openai.gpt-6-luna',
    ])
    expect(routed.why).toBe(
      'typesafe/jev-latest picked openai/gpt-6-luna, confidence 0.81',
    )
  })
})

describe('what the routing question says of the added models', () => {
  test('success: each model of its own is described by its published line', () => {
    const { candidates } = candidatesOf(
      { provider: 'perplexity', model: 'pplx-decider-v1-27b' },
      ['perplexity', 'openai'],
      ALL_KEYS,
      FITS,
    )

    expect(
      Object.fromEntries(
        candidates.map(candidate => [candidate.key, candidate.about]),
      ),
    ).toEqual({
      'perplexity.pplx-decider-v1-27b':
        "Perplexity's 27B decision model. It reads text and images and " +
        'returns typed answers with probabilities.',
      'openai.gpt-6-luna':
        'GPT-6 Luna, which OpenAI describes as its most efficient model ' +
        'for focused, high-volume tasks, served through its Decisions API.',
    })
  })
})
