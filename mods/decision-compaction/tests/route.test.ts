import { describe, expect, test } from 'claude-code/testing'

import type { Ask } from '../hooks/compact'
import type { Credentials, Route } from '../hooks/providers'
import {
  candidatesOf,
  chooseRoute,
  labelOf,
  profileOf,
  ROUTE_QUESTION,
  routeQuestionOf,
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
          [ROUTE_QUESTION]: { type: 'choice', choice: pick, confidence: 0.81 },
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
      const found = candidatesOf(configured, credentials, FITS)

      expect(found.candidates.map(candidate => candidate.key)).toEqual(keys)
      expect(found.refused).toEqual(refused)
      expect(found.isConfiguredUsable).toBe(usable)
    })
  }

  test('success: a route the state does not fit is left out with the reason', () => {
    const found = candidatesOf(
      TYPESAFE,
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

  test('success: the question offers exactly the candidates', () => {
    const { candidates } = candidatesOf(CLEF, CLOUDFLARE_KEYS, FITS)
    const question = routeQuestionOf(candidates)

    expect(question.type).toBe('choice')
    expect(Object.keys(question.criteria)).toEqual([
      'cloudflare.clef',
      'cloudflare.clef-flash',
    ])
    expect(labelOf(CLEF_FLASH)).toBe('cloudflare/clef-flash')
  })
})
