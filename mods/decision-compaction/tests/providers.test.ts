import { describe, expect, test } from 'claude-code/testing'

import { OPENAI } from '../hooks/openai'
import {
  credentialsFor,
  credentialsOf,
  environmentOf,
  exchangeOf,
  isRetryable,
  limitsOf,
  missingOf,
  modelsOf,
  providerOf,
  REASON_CHARS,
  redacted,
  replyFrom,
  routeOf,
  unresolvedOf,
  wireOf,
} from '../hooks/providers'
import type { Credentials, ProviderName, Route } from '../hooks/providers'
import { BARE, choiceOf, noulOf } from '../hooks/systemone'
import type { Questions } from '../hooks/systemone'

/**
 * The keys of TypeSafe, OpenRouter and Cloudflare and the Cloudflare
 * account: with these alone any other provider is one that is not
 * configured.
 */
const CREDENTIALS: Credentials = {
  typesafeApiKey: 'test-typesafe-key',
  openrouterApiKey: 'test-openrouter-key',
  cloudflareApiToken: 'test-cloudflare-token',
  cloudflareAccountId: 'test-account',
}

/**
 * The keys of every provider, so that a test can check that none of them
 * leaks.
 */
const ALL: Credentials = {
  ...CREDENTIALS,
  codivApiKey: 'test-codiv-key',
  perplexityApiKey: 'test-perplexity-key',
  decisionsApiKey: 'test-decisions-key',
  decisionapiApiKey: 'test-decisionapi-key',
  openaiApiKey: 'test-openai-key',
}

const QUESTIONS = { call_t1: { type: 'noul', instructions: 'Is it?' } } as const

function response(status: number, payload: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    text: typeof payload === 'string' ? payload : JSON.stringify(payload),
  }
}

const ANSWERS = { call_t1: { type: 'noul', noul: 0.25 } }

/**
 * The two questions the providers were probed with, in the order they were
 * sent.
 */
const PROBED: Questions = {
  asks_weather: {
    type: 'noul',
    instructions: 'Does the user ask about the weather?',
  },
  topic: {
    type: 'choice',
    instructions: 'What is the conversation about?',
    criteria: { weather: null, cooking: null, code: null },
  },
}

describe('exchangeOf', () => {
  const requests: Record<
    string,
    { route: Route; url: string; bearer: string; model: string }
  > = {
    'success: typesafe posts to its System One endpoint': {
      route: routeOf('typesafe'),
      url: 'https://api.typesafe.ai/v1/systemone',
      bearer: 'Bearer test-typesafe-key',
      model: 'jev-latest',
    },
    'success: openrouter posts to its System One endpoint': {
      route: routeOf('openrouter'),
      url: 'https://openrouter.ai/api/v1/systemone',
      bearer: 'Bearer test-openrouter-key',
      model: '~typesafe/jev-latest',
    },
    'success: a bare jev id is sent to openrouter as written': {
      route: routeOf('openrouter', 'jev-1.13'),
      url: 'https://openrouter.ai/api/v1/systemone',
      bearer: 'Bearer test-openrouter-key',
      model: 'jev-1.13',
    },
    'success: cloudflare puts the account and the catalogue id in the URL': {
      route: routeOf('cloudflare'),
      url: 'https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/cloudflare/clef',
      bearer: 'Bearer test-cloudflare-token',
      model: 'clef',
    },
    'success: a cloudflare catalogue id is sent as its short name': {
      route: routeOf('cloudflare', ' @cf/cloudflare/clef-flash '),
      url: 'https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/cloudflare/clef-flash',
      bearer: 'Bearer test-cloudflare-token',
      model: 'clef-flash',
    },
    'success: a configured model replaces the default': {
      route: routeOf('typesafe', 'jev-1.13.0'),
      url: 'https://api.typesafe.ai/v1/systemone',
      bearer: 'Bearer test-typesafe-key',
      model: 'jev-1.13.0',
    },
  }

  for (const [name, { route, url, bearer, model }] of Object.entries(
    requests,
  )) {
    test(name, () => {
      const exchange = exchangeOf(route, CREDENTIALS, { goal: 'g' }, QUESTIONS)

      expect(exchange.url).toBe(url)
      expect(exchange.init.method).toBe('POST')
      expect(exchange.init.headers).toEqual({
        authorization: bearer,
        'content-type': 'application/json',
      })
      expect(JSON.parse(exchange.init.body)).toEqual({
        model,
        state: { goal: 'g' },
        questions: { call_t1: { type: 'noul', instructions: 'Is it?' } },
      })
    })
  }

  const STATE = { goal: 'g', conversation: [{ at: 0, text: 'a "b"' }] }
  const ASKED = {
    call_t1: { type: 'noul', instructions: 'Is it?' },
    route: {
      type: 'choice',
      instructions: 'Which?',
      criteria: {
        'codiv.openjev-latest': 'Open Jev.',
        'openai.gpt-6-luna': null,
      },
    },
  } as const
  const bareBody = (model: string, ids = ['call_t1', 'route']) =>
    `{"model":"${model}",` +
    '"state":{"goal":"g","conversation":[{"at":0,"text":"a \\"b\\""}]},' +
    `"questions":{"${ids[0]}":{"type":"noul","instructions":"Is it?"},` +
    `"${ids[1]}":{"type":"choice","instructions":"Which?","criteria":` +
    '{"codiv.openjev-latest":"Open Jev.","openai.gpt-6-luna":null}}}}'

  const sent: Record<
    string,
    { route: Route; url: string; key: string; body: string }
  > = {
    'success: the typesafe request is the bare body at its endpoint': {
      route: routeOf('typesafe'),
      url: 'https://api.typesafe.ai/v1/systemone',
      key: 'test-typesafe-key',
      body: bareBody('jev-latest'),
    },
    'success: the openrouter request is the bare body at its endpoint': {
      route: routeOf('openrouter'),
      url: 'https://openrouter.ai/api/v1/systemone',
      key: 'test-openrouter-key',
      body: bareBody('~typesafe/jev-latest'),
    },
    'success: the cloudflare request is the bare body under the account URL': {
      route: routeOf('cloudflare', 'clef-flash'),
      url: 'https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/cloudflare/clef-flash',
      key: 'test-cloudflare-token',
      body: bareBody('clef-flash'),
    },
    'success: codiv is sent the bare body at its endpoint': {
      route: routeOf('codiv'),
      url: 'https://api.codiv.ai/v1/systemone',
      key: 'test-codiv-key',
      body: bareBody('openjev-latest'),
    },
    'success: perplexity is sent the bare body with its own decider': {
      route: routeOf('perplexity'),
      url: 'https://api.perplexity.ai/v1/decisions',
      key: 'test-perplexity-key',
      body: bareBody('pplx-decider-v1.1-27b'),
    },
    'success: decisions-api.dev is sent the bare body with each question named by its place':
      {
        route: routeOf('decisions-api-dev'),
        url: 'https://decisions-api.dev/v1/systemone',
        key: 'test-decisions-key',
        body: bareBody('jev-latest', ['q0', 'q1']),
      },
    'success: decisionapi.net is sent the bare body for jev': {
      route: routeOf('decisionapi-net'),
      url: 'https://decisionapi.net/v1/systemone',
      key: 'test-decisionapi-key',
      body: bareBody('jev-latest'),
    },
    'success: openai is sent the state as text and the questions as a list': {
      route: routeOf('openai'),
      url: 'https://api.openai.com/v1/decisions',
      key: 'test-openai-key',
      body:
        '{"model":"gpt-6-luna",' +
        '"input":"{\\"goal\\":\\"g\\",\\"conversation\\":' +
        '[{\\"at\\":0,\\"text\\":\\"a \\\\\\"b\\\\\\"\\"}]}",' +
        '"questions":[' +
        '{"name":"call_t1","type":"predicate","instructions":"Is it?"},' +
        '{"name":"route","type":"choice","instructions":"Which?",' +
        '"choices":[{"value":"codiv.openjev-latest","description":"Open Jev."},' +
        '{"value":"openai.gpt-6-luna"}]}]}',
    },
  }

  for (const [name, { route, url, key, body }] of Object.entries(sent)) {
    test(name, () => {
      const exchange = exchangeOf(route, ALL, STATE, ASKED)

      expect(exchange).toEqual({
        url,
        init: {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body,
        },
      })

      for (const secret of Object.values(ALL)) {
        if (secret !== 'test-account') {
          const sent = `${exchange.url} ${exchange.init.body}`

          expect(
            sent.includes(secret),
            `${secret} is in the URL or the body`,
          ).toBe(false)
        }
      }
    })
  }

  const unconfigured: Record<
    string,
    { route: Route; has: Credentials; message: string }
  > = {
    'error: typesafe without a key names the variable to set': {
      route: routeOf('typesafe'),
      has: {},
      message: 'typesafe is not configured: TYPESAFE_API_KEY is unset',
    },
    'error: cloudflare without an account id names it': {
      route: routeOf('cloudflare'),
      has: { cloudflareApiToken: 'test-cloudflare-token' },
      message: 'cloudflare is not configured: CLOUDFLARE_ACCOUNT_ID is unset',
    },
    'error: cloudflare with nothing names both variables': {
      route: routeOf('cloudflare'),
      has: {},
      message:
        'cloudflare is not configured: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID is unset',
    },
    'error: openrouter without a key names the variable to set': {
      route: routeOf('openrouter'),
      has: { typesafeApiKey: 'test-typesafe-key' },
      message: 'openrouter is not configured: OPENROUTER_API_KEY is unset',
    },
    'error: codiv without a key names the variable to set': {
      route: routeOf('codiv'),
      has: CREDENTIALS,
      message: 'codiv is not configured: CODIV_API_KEY is unset',
    },
    'error: perplexity without a key names the variable to set': {
      route: routeOf('perplexity'),
      has: CREDENTIALS,
      message: 'perplexity is not configured: PERPLEXITY_API_KEY is unset',
    },
    'error: decisions-api.dev without a key names the variable to set': {
      route: routeOf('decisions-api-dev'),
      has: CREDENTIALS,
      message: 'decisions-api-dev is not configured: DECISIONS_API_KEY is unset',
    },
    'error: decisionapi.net without a key names the variable to set': {
      route: routeOf('decisionapi-net'),
      has: CREDENTIALS,
      message: 'decisionapi-net is not configured: DECISIONAPI_API_KEY is unset',
    },
    'error: openai without a key names the variable to set': {
      route: routeOf('openai'),
      has: CREDENTIALS,
      message: 'openai is not configured: OPENAI_API_KEY is unset',
    },
  }

  for (const [name, { route, has, message }] of Object.entries(unconfigured)) {
    test(name, () => {
      expect(() => exchangeOf(route, has, 's', QUESTIONS)).toThrow({ message })
    })
  }

  test('success: only openai and decisions-api.dev write the body their own way', () => {
    expect(wireOf(routeOf('openai'))).toBe(OPENAI)
    expect(wireOf(routeOf('decisions-api-dev'))).not.toBe(BARE)

    for (const provider of [
      'typesafe',
      'cloudflare',
      'openrouter',
      'codiv',
      'perplexity',
      'decisionapi-net',
    ] as const) {
      expect(wireOf(routeOf(provider)), provider).toBe(BARE)
    }
  })
})

describe('routeOf', () => {
  test('error: a model cloudflare does not serve is refused before any request', () => {
    expect(() => routeOf('cloudflare', 'jev-latest')).toThrow(
      'cloudflare serves clef, clef-flash and clef-omni, not "jev-latest"',
    )
  })

  test('success: a blank model reads as the default', () => {
    expect(routeOf('openrouter', '  ')).toEqual({
      provider: 'openrouter',
      model: '~typesafe/jev-latest',
    })
  })

  test("success: openrouter's default is its alias for the newest jev", () => {
    expect(routeOf('openrouter').model).toBe('~typesafe/jev-latest')
    expect(routeOf('typesafe').model).toBe('jev-latest')
    expect(routeOf('cloudflare').model).toBe('clef')
  })
})

describe('limits', () => {
  test('success: each provider states its limits', () => {
    expect(limitsOf(routeOf('typesafe'))).toEqual({
      maxStateTokens: 32000,
      maxRequestTokens: 64000,
    })
    expect(limitsOf(routeOf('openrouter'))).toEqual({
      maxStateTokens: 32000,
      maxRequestTokens: 32000,
    })
    expect(limitsOf(routeOf('cloudflare'))).toEqual({
      maxStateTokens: 64000,
      maxRequestTokens: 64000,
      maxQuestions: 64,
    })
  })

  // A state past the window is cut without a word and the reply counts
  // exactly 64,000 on clef and clef-omni and 24,000 on clef-flash, so those
  // are the limits whatever the catalogue states.
  const clefs: Record<string, { model: string; window: number }> = {
    'success: clef holds the 64,000 it reads': {
      model: 'clef',
      window: 64000,
    },
    'success: clef-flash holds the 24,000 it reads': {
      model: 'clef-flash',
      window: 24000,
    },
    'success: clef-omni holds its 64,000 window': {
      model: 'clef-omni',
      window: 64000,
    },
    'success: a catalogue id holds the limits of the model it names': {
      model: '@cf/cloudflare/clef-flash',
      window: 24000,
    },
  }

  for (const [name, { model, window }] of Object.entries(clefs)) {
    test(name, () => {
      expect(limitsOf(routeOf('cloudflare', model))).toEqual({
        maxStateTokens: window,
        maxRequestTokens: window,
        maxQuestions: 64,
      })
    })
  }

  const limits: Record<string, { provider: ProviderName; expected: object }> =
    {
      'success: codiv holds its window and the 256 questions it takes': {
        provider: 'codiv',
        expected: {
          maxStateTokens: 60000,
          maxRequestTokens: 65536,
          maxQuestions: 256,
        },
      },
      'success: perplexity holds its window and 128 questions': {
        provider: 'perplexity',
        expected: {
          maxStateTokens: 262143,
          maxRequestTokens: 262143,
          maxQuestions: 128,
        },
      },
      "success: decisions-api.dev holds 8 questions within 32 KiB and Jev's window": {
        provider: 'decisions-api-dev',
        expected: {
          maxStateTokens: 32000,
          maxRequestTokens: 64000,
          maxQuestions: 8,
          maxRequestBytes: 32768,
        },
      },
      "success: decisionapi.net holds 8 questions within 32 KiB and Jev's window": {
        provider: 'decisionapi-net',
        expected: {
          maxStateTokens: 32000,
          maxRequestTokens: 64000,
          maxQuestions: 8,
          maxRequestBytes: 32768,
        },
      },
      'success: openai holds 200 questions within its price step': {
        provider: 'openai',
        expected: {
          maxStateTokens: 272000,
          maxRequestTokens: 272000,
          maxQuestions: 200,
        },
      },
    }

  for (const [name, { provider, expected }] of Object.entries(limits)) {
    test(name, () => {
      expect(limitsOf(routeOf(provider))).toEqual(expected)
    })
  }

  const gateway: Record<
    string,
    { model: string; maxQuestions?: number; window?: number }
  > = {
    // OpenRouter's Clef and Clef-flash cut a state at 16,384 tokens.
    'success: clef over openrouter takes 64 questions in the 16,384 it reads':
      {
        model: 'cloudflare/clef',
        maxQuestions: 64,
        window: 16384,
      },
    'success: clef-flash over openrouter takes 64 questions in the 16,384 it reads':
      {
        model: 'cloudflare/clef-flash',
        maxQuestions: 64,
        window: 16384,
      },
    "success: clef-omni over openrouter is held to the gateway's window": {
      model: 'cloudflare/clef-omni',
      maxQuestions: 64,
    },
    'success: a model name that is also an object key is no window': {
      model: 'constructor',
      maxQuestions: 64,
    },
    'success: a model openrouter does not route to jev is held to 64 questions':
      { model: 'someone/other-model', maxQuestions: 64 },
    'success: jev over openrouter by its alias has no question cap': {
      model: '~typesafe/jev-latest',
    },
    'success: jev over openrouter by a bare id has no question cap': {
      model: 'jev-1.13',
    },
  }

  for (const [name, { model, maxQuestions, window }] of Object.entries(
    gateway,
  )) {
    test(name, () => {
      const expected: Record<string, number> = {
        maxStateTokens: window ?? 32000,
        maxRequestTokens: window ?? 32000,
      }

      if (maxQuestions !== undefined) {
        expected.maxQuestions = maxQuestions
      }

      expect(limitsOf(routeOf('openrouter', model))).toEqual(expected)
    })
  }

  test('success: only cloudflare offers more than one model', () => {
    expect(modelsOf('cloudflare')).toEqual(['clef', 'clef-flash', 'clef-omni'])
    expect(modelsOf('typesafe')).toEqual(['jev-latest'])
    expect(modelsOf('openrouter')).toEqual(['~typesafe/jev-latest'])
  })

  test('success: each is offered with its default model', () => {
    expect(modelsOf('codiv')).toEqual(['openjev-latest'])
    expect(modelsOf('perplexity')).toEqual(['pplx-decider-v1.1-27b'])
    expect(modelsOf('decisions-api-dev')).toEqual(['jev-latest'])
    expect(modelsOf('decisionapi-net')).toEqual(['jev-latest'])
    expect(modelsOf('openai')).toEqual(['gpt-6-luna'])
  })

  test('success: only a listed name is a provider', () => {
    expect(providerOf('cloudflare')).toBe('cloudflare')
    expect(providerOf('openai')).toBe('openai')
    expect(providerOf('decisions-api-dev')).toBe('decisions-api-dev')
    expect(providerOf('typellm')).toBeUndefined()
    expect(providerOf('nope')).toBeUndefined()
    expect(providerOf(undefined)).toBeUndefined()
  })

  test('success: each is named by the provider option', () => {
    for (const name of [
      'codiv',
      'perplexity',
      'decisions-api-dev',
      'decisionapi-net',
      'openai',
    ]) {
      expect(providerOf(name)).toBe(name)
    }
  })
})

describe('replyFrom', () => {
  test('success: a typesafe body is the reply', () => {
    const reply = replyFrom(
      routeOf('typesafe'),
      response(200, {
        model: 'jev-1.13.0',
        answers: ANSWERS,
        usage: { input_tokens: 296, output_tokens: 20 },
      }),
      CREDENTIALS,
      QUESTIONS,
    )

    expect(reply).toEqual({
      model: 'jev-1.13.0',
      answers: ANSWERS,
      usage: { input_tokens: 296 },
    })
  })

  test('success: an openrouter body carries its cost', () => {
    const reply = replyFrom(
      routeOf('openrouter'),
      response(200, {
        id: 'gen-dec-1',
        provider: 'TypeSafe',
        model: 'typesafe/jev-1.13-20260917',
        answers: ANSWERS,
        usage: { cost: 0.000019992, input_tokens: 476, output_tokens: 70 },
      }),
      CREDENTIALS,
      QUESTIONS,
    )

    expect(reply.usage).toEqual({ cost: 0.000019992, input_tokens: 476 })
    expect(reply.answers).toEqual(ANSWERS)
  })
  test('success: a cloudflare envelope is unwrapped', () => {
    const reply = replyFrom(
      routeOf('cloudflare'),
      response(200, {
        result: {
          model: 'clef',
          answers: ANSWERS,
          usage: { input_tokens: 9, output_tokens: 1 },
        },
        success: true,
        errors: [],
        messages: [],
      }),
      CREDENTIALS,
      QUESTIONS,
    )

    expect(reply).toEqual({
      model: 'clef',
      answers: ANSWERS,
      usage: { input_tokens: 9 },
    })
  })

  test('success: a bare cloudflare body is read without an envelope', () => {
    const reply = replyFrom(
      routeOf('cloudflare'),
      response(200, { answers: ANSWERS }),
      CREDENTIALS,
      QUESTIONS,
    )

    expect(reply).toEqual({ answers: ANSWERS, usage: {} })
  })

  const recorded: Record<
    string,
    { provider: ProviderName; payload: unknown; expected: object }
  > = {
    'success: the recorded perplexity body is the reply': {
      provider: 'perplexity',
      payload: {
        model: 'pplx-decider-v1.1-27b',
        answers: {
          asks_weather: { type: 'noul', noul: 0.9997546075625011 },
          topic: {
            type: 'choice',
            choice: 'weather',
            confidence: 0.9999119392823574,
            probabilities: {
              weather: 0.99994,
              cooking: 0.00002,
              code: 0.00004,
            },
          },
        },
        usage: { input_tokens: 286, output_tokens: 2 },
      },
      expected: {
        model: 'pplx-decider-v1.1-27b',
        usage: { input_tokens: 286 },
      },
    },
    'success: the recorded codiv body is the reply': {
      provider: 'codiv',
      payload: {
        model: 'openjev-0.1',
        answers: {
          asks_weather: { type: 'noul', noul: 0.9974021261033258 },
          topic: {
            type: 'choice',
            choice: 'weather',
            confidence: 0.9986455718188082,
          },
        },
        usage: { input_tokens: 173, output_tokens: 0 },
      },
      expected: {
        model: 'openjev-0.1',
        usage: { input_tokens: 173 },
      },
    },
    'success: the recorded decisionapi.net envelope is unwrapped': {
      provider: 'decisionapi-net',
      payload: {
        code: 0,
        message: 'ok',
        data: {
          result: {
            answers: {
              asks_weather: { type: 'noul', noul: 0.99 },
              topic: {
                type: 'choice',
                choice: 'weather',
                probabilities: { code: 0, cooking: 0, weather: 1 },
                confidence: 1,
              },
            },
            usage: { input_tokens: 405, output_tokens: 57 },
            elapsedMs: 1448,
          },
          creditsUsed: 1,
        },
      },
      expected: { usage: { input_tokens: 405 } },
    },
    'success: a decisions-api.dev envelope is unwrapped with its model': {
      provider: 'decisions-api-dev',
      payload: {
        code: 0,
        message: 'ok',
        data: {
          result: {
            model: 'typesafe/jev-1.13-20260917',
            answers: {
              q0: { type: 'noul', noul: 0.99 },
              q1: { type: 'choice', choice: 'weather', confidence: 1 },
            },
            usage: { input_tokens: 405, output_tokens: 57 },
          },
        },
      },
      expected: {
        model: 'typesafe/jev-1.13-20260917',
        usage: { input_tokens: 405 },
      },
    },
    'success: the recorded openai answer list is the reply': {
      provider: 'openai',
      payload: {
        model: 'gpt-6-luna',
        answers: [
          { type: 'predicate', name: 'asks_weather', probability: 1.0 },
          {
            type: 'choice',
            name: 'topic',
            choice: 'weather',
            probabilities: [
              { value: 'weather', probability: 1.0 },
              { value: 'cooking', probability: 0.0 },
            ],
            confidence: 1.0,
          },
        ],
        usage: {
          input_tokens: 318,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 0,
          total_tokens: 318,
        },
      },
      expected: {
        model: 'gpt-6-luna',
        usage: { input_tokens: 318 },
      },
    },
  }

  for (const [name, { provider, payload, expected }] of Object.entries(
    recorded,
  )) {
    test(name, () => {
      const reply = replyFrom(
        routeOf(provider),
        response(200, payload),
        ALL,
        PROBED,
      )

      expect(reply).toMatchObject(expected)
      expect('model' in reply).toBe('model' in expected)
      expect(noulOf(reply, 'asks_weather') > 0.9).toBe(true)
      expect(choiceOf(reply, 'topic', ['weather', 'cooking', 'code'])).toEqual(
        expect.objectContaining({ choice: 'weather' }),
      )
    })
  }

  const failures: Record<
    string,
    { route: Route; status: number; payload: unknown; message: string }
  > = {
    'error: a cloudflare envelope reporting failure gives its first error': {
      route: routeOf('cloudflare'),
      status: 200,
      payload: {
        result: null,
        success: false,
        errors: [
          { code: 5007, message: 'No such model' },
          { code: 1, message: 'second' },
        ],
      },
      message:
        'cloudflare: the response envelope reports failure: No such model',
    },
    'error: a cloudflare HTTP error gives the envelope reason': {
      route: routeOf('cloudflare'),
      status: 401,
      payload: {
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
      },
      message: 'cloudflare answered HTTP 401: Authentication error',
    },
    'error: an openrouter HTTP error gives error.message': {
      route: routeOf('openrouter'),
      status: 402,
      payload: { error: { code: 402, message: 'Insufficient credits' } },
      message: 'openrouter answered HTTP 402: Insufficient credits',
    },
    'error: a refusal openrouter passes on from its host names the field': {
      route: routeOf('openrouter', 'cloudflare/clef'),
      status: 422,
      payload: {
        error: {
          code: 422,
          message:
            'HTTP 422: ' +
            JSON.stringify({
              errors: [
                {
                  message:
                    'AiError: AiError: ' +
                    JSON.stringify({
                      error: {
                        type: 'invalid_request',
                        message: 'Request body failed validation',
                        details: {
                          formErrors: [],
                          fieldErrors: {
                            questions: [
                              'Dictionary should have at most 64 items after validation, not 114',
                            ],
                          },
                        },
                      },
                    }) +
                    ' (41e95187-1b83-4943-b077-73fb4676c6ea)',
                  code: 5012,
                },
              ],
              success: false,
              result: {},
              messages: [],
            }),
        },
      },
      message:
        'openrouter answered HTTP 422: Request body failed validation: ' +
        'questions: Dictionary should have at most 64 items after ' +
        'validation, not 114',
    },
    'error: a reason that only repeats the status loses the repeat': {
      route: routeOf('openrouter'),
      status: 502,
      payload: { error: { code: 502, message: 'HTTP 502: Bad gateway' } },
      message: 'openrouter answered HTTP 502: Bad gateway',
    },
    'error: a quoted body that is not JSON is kept as written': {
      route: routeOf('openrouter'),
      status: 422,
      payload: { error: { message: 'HTTP 422: {not json' } },
      message: 'openrouter answered HTTP 422: {not json',
    },
    'error: a plain-text error body is quoted': {
      route: routeOf('typesafe'),
      status: 529,
      payload: 'Overloaded',
      message: 'typesafe answered HTTP 529: Overloaded',
    },
    'error: an empty error body still names the status': {
      route: routeOf('typesafe'),
      status: 500,
      payload: '',
      message: 'typesafe answered HTTP 500: no reason given',
    },
    'error: a 2xx body that is not JSON is refused': {
      route: routeOf('typesafe'),
      status: 200,
      payload: '<html>',
      message: 'typesafe answered a body that is not JSON',
    },
    'error: a 2xx body without answers is refused': {
      route: routeOf('typesafe'),
      status: 200,
      payload: { model: 'jev-1.13.0' },
      message: 'typesafe: the response holds no answers object',
    },
    'error: a JSON error body that repeats the key is quoted without it': {
      route: routeOf('typesafe'),
      status: 401,
      payload: {
        error: {
          message:
            'key test-typesafe-key rejected (Authorization: Bearer test-typesafe-key)',
        },
      },
      // What follows the scheme is taken up to the next white space, so
      // the bracket that closed the echo goes with the token.
      message:
        'typesafe answered HTTP 401: key [redacted] rejected (Authorization: [redacted]',
    },
    'error: a raw error body that repeats the header is quoted without it': {
      route: routeOf('openrouter'),
      status: 403,
      payload:
        '<html><body>denied\n<pre>authorization: Bearer test-openrouter-key</pre></body></html>',
      message:
        'openrouter answered HTTP 403: <html><body>denied <pre>authorization: [redacted]</pre></body></html>',
    },
    "error: another provider's key in an error body is taken out too": {
      route: routeOf('typesafe'),
      status: 400,
      payload: { detail: 'unexpected token test-cloudflare-token' },
      message: 'typesafe answered HTTP 400: unexpected token [redacted]',
    },
    'error: a bearer token this mod never held is taken out': {
      route: routeOf('typesafe'),
      status: 401,
      payload: { message: 'got bearer sk-someone-elses-token where ours goes' },
      message: 'typesafe answered HTTP 401: got [redacted] where ours goes',
    },
    'error: a cloudflare failure envelope that repeats the token is quoted without it':
      {
        route: routeOf('cloudflare'),
        status: 200,
        payload: {
          success: false,
          errors: [{ message: 'token test-cloudflare-token has no access' }],
        },
        message:
          'cloudflare: the response envelope reports failure: token [redacted] has no access',
      },
    'error: a long cloudflare failure envelope is cut to one short line': {
      route: routeOf('cloudflare'),
      status: 200,
      payload: {
        success: false,
        errors: [{ message: `capacity\n${'m'.repeat(300)}` }],
      },
      // The whole line after the provider's name is held to the limit, the
      // words this mod puts before the quoted reason included.
      message:
        'cloudflare: the response envelope reports failure: ' +
        `capacity ${'m'.repeat(112)}…`,
    },
    'error: a cloudflare failure envelope with no error says so': {
      route: routeOf('cloudflare'),
      status: 200,
      payload: { success: false, errors: [] },
      message:
        'cloudflare: the response envelope reports failure: no reason given',
    },
    'error: a typesafe count of input tokens at its request limit is refused': {
      route: routeOf('typesafe'),
      status: 200,
      payload: { answers: ANSWERS, usage: { input_tokens: 64000 } },
      message:
        'typesafe counted 64000 input tokens, all that a request of its may ' +
        'hold (64000): the state was probably cut short, so the answers ' +
        'decide nothing',
    },
    'error: an openrouter count of input tokens past its limit is refused': {
      route: routeOf('openrouter'),
      status: 200,
      payload: { answers: ANSWERS, usage: { input_tokens: 32001 } },
      message:
        'openrouter counted 32001 input tokens, all that a request of its ' +
        'may hold (32000): the state was probably cut short, so the answers ' +
        'decide nothing',
    },
    'error: a clef count of the 64,000 tokens it cuts a state to is refused': {
      route: routeOf('cloudflare'),
      status: 200,
      payload: {
        success: true,
        result: { answers: ANSWERS, usage: { input_tokens: 64000 } },
      },
      message:
        'cloudflare counted 64000 input tokens, all that a request of its ' +
        'may hold (64000): the state was probably cut short, so the answers ' +
        'decide nothing',
    },
    'error: a clef-flash count of the 24,000 tokens it cuts a state to is refused':
      {
        route: routeOf('cloudflare', 'clef-flash'),
        status: 200,
        payload: {
          success: true,
          result: { answers: ANSWERS, usage: { input_tokens: 24000 } },
        },
        message:
          'cloudflare counted 24000 input tokens, all that a request of its ' +
          'may hold (24000): the state was probably cut short, so the ' +
          'answers decide nothing',
      },
    'error: a clef-omni count of its 64,000 window is refused': {
      route: routeOf('cloudflare', 'clef-omni'),
      status: 200,
      payload: {
        success: true,
        result: { answers: ANSWERS, usage: { input_tokens: 64000 } },
      },
      message:
        'cloudflare counted 64000 input tokens, all that a request of its ' +
        'may hold (64000): the state was probably cut short, so the answers ' +
        'decide nothing',
    },
    'error: an envelope reporting failure is quoted with its message': {
      route: routeOf('decisions-api-dev'),
      status: 200,
      payload: { code: 1, message: 'insufficient credits', data: null },
      message:
        'decisions-api-dev: the response envelope reports failure: ' +
        'insufficient credits',
    },
    'error: an envelope without a result is a failure': {
      route: routeOf('decisionapi-net'),
      status: 200,
      payload: { code: 0, message: 'ok', data: {} },
      message: 'decisionapi-net: the response envelope reports failure: ok',
    },
    'error: an envelope with no code at all is a failure': {
      route: routeOf('decisionapi-net'),
      status: 200,
      payload: { answers: {} },
      message:
        'decisionapi-net: the response envelope reports failure: ' +
        'no reason given',
    },
    'error: an envelope that repeats the key is quoted without it': {
      route: routeOf('decisions-api-dev'),
      status: 200,
      payload: { code: 401, message: 'key test-decisions-key is revoked' },
      message:
        'decisions-api-dev: the response envelope reports failure: ' +
        'key [redacted] is revoked',
    },
    'error: an envelope reason on a failed status is quoted': {
      route: routeOf('decisionapi-net'),
      status: 402,
      payload: { code: 1, message: 'insufficient credits' },
      message: 'decisionapi-net answered HTTP 402: insufficient credits',
    },
    'error: an openai answer of an unknown type is refused, naming the type': {
      route: routeOf('openai'),
      status: 200,
      payload: {
        answers: [{ type: 'score', name: 'asks_weather' }],
        usage: {},
      },
      message:
        'openai: answers[0].type is "score", neither predicate nor choice',
    },
    'error: an openai error body is quoted by its message': {
      route: routeOf('openai'),
      status: 400,
      payload: {
        error: {
          message: "Invalid type for 'questions': expected an array",
          type: 'invalid_request_error',
          param: 'questions',
        },
      },
      message:
        "openai answered HTTP 400: Invalid type for 'questions': " +
        'expected an array',
    },
    'error: perplexity refusing a model is quoted': {
      route: routeOf('perplexity'),
      status: 400,
      payload: {
        error: { code: null, message: "Invalid model 'jev-latest'." },
      },
      message: "perplexity answered HTTP 400: Invalid model 'jev-latest'.",
    },
  }

  for (const [name, { route, status, payload, message }] of Object.entries(
    failures,
  )) {
    test(name, () => {
      expect(() =>
        replyFrom(route, response(status, payload), ALL, PROBED),
      ).toThrow({ message })
    })
  }

  test('success: a count of input tokens one under the limit is a reply', () => {
    expect(
      replyFrom(
        routeOf('openrouter'),
        response(200, { answers: ANSWERS, usage: { input_tokens: 31999 } }),
        CREDENTIALS,
        QUESTIONS,
      ).usage,
    ).toEqual({ input_tokens: 31999 })
  })

  /**
   * The message thrown for an error body, whatever it is.
   */
  function messageFor(body: string): string {
    try {
      replyFrom(
        routeOf('typesafe'),
        response(422, body),
        CREDENTIALS,
        QUESTIONS,
      )
    } catch (error) {
      return (error as Error).message
    }

    return 'nothing was thrown'
  }

  test('error: a long error body is cut to one short line', () => {
    expect(messageFor(`bad\n${'x'.repeat(500)}`)).toBe(
      `typesafe answered HTTP 422: bad ${'x'.repeat(156)}…`,
    )
  })

  test('error: a key the cut would fall inside leaves no part of itself', () => {
    // The key starts at character 150 of the reason, so the 160-character
    // cut would end ten characters into it.
    const message = messageFor(`${'x'.repeat(150)}test-typesafe-key and more`)

    expect(message).toBe(
      `typesafe answered HTTP 422: ${'x'.repeat(150)}[redacted]…`,
    )
    expect(message.includes('test-')).toBe(false)
  })

  test('error: the cut never ends on half a surrogate pair', () => {
    // The emoji takes characters 159 and 160, so a cut at 160 would keep its
    // first half alone.
    const message = messageFor(`${'x'.repeat(159)}😀${'y'.repeat(50)}`)

    expect(message).toBe(`typesafe answered HTTP 422: ${'x'.repeat(159)}…`)
  })

  /**
   * What `replyFrom` threw for a response, as a string.
   */
  function failureOf(provider: ProviderName, status: number, payload: unknown) {
    try {
      replyFrom(routeOf(provider), response(status, payload), ALL, PROBED)
    } catch (error) {
      return (error as Error).message
    }

    return 'no failure'
  }

  /**
   * Checks a message quotes a vendor's text the way every message must: on
   * one line no longer than the limit after the words that lead it, with no
   * control character and no key.
   */
  function expectQuotable(message: string, lead: string) {
    expect(message.startsWith(lead), message).toBe(true)
    expect(
      message.length <= lead.length + REASON_CHARS + 1,
      `${message.length} characters: ${message}`,
    ).toBe(true)
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(message), message).toBe(false)

    for (const key of Object.values(ALL)) {
      if (key !== ALL.cloudflareAccountId) {
        expect(message.includes(key), message).toBe(false)
      }
    }
  }

  const echoed = `${ALL.openaiApiKey}\n\u001b[31m\u009b${'r'.repeat(5000)}`

  test('error: a 5,000-character refusal name with control characters and a key is not quoted', () => {
    const message = failureOf('openai', 200, {
      answers: [{ type: 'refusal', name: echoed, refusal: 'no' }],
    })

    expectQuotable(message, 'openai: ')
    expect(message).toBe(
      'openai: answers[0].name is a value of 5030 characters, which was ' +
        'not asked',
    )
  })

  test('error: a short type with a key in it is quoted whole and then redacted', () => {
    const message = failureOf('openai', 200, {
      answers: [{ type: `x ${ALL.openaiApiKey}`, name: 'asks_weather' }],
    })

    expectQuotable(message, 'openai: ')
    expect(message).toBe(
      'openai: answers[0].type is "x [redacted]", neither predicate nor ' +
        'choice',
    )
  })

  test('error: an envelope message with control characters and a key is one short redacted line', () => {
    const message = failureOf('decisionapi-net', 200, {
      code: 1,
      message: echoed,
    })

    expectQuotable(message, 'decisionapi-net: ')
    expect(
      message.startsWith(
        'decisionapi-net: the response envelope reports failure: ' +
          '[redacted] [31m rrr',
      ),
    ).toBe(true)
    expect(message.endsWith('r…')).toBe(true)
  })

  test('error: an error body with control characters and a key is one short redacted line', () => {
    const message = failureOf('openai', 400, { error: { message: echoed } })

    expectQuotable(message, 'openai answered HTTP 400: ')
    expect(
      message.startsWith('openai answered HTTP 400: [redacted] [31m rrr'),
    ).toBe(true)
  })

  /**
   * A response body inside the envelope the two Decisions resellers answer
   * with.
   */
  const enveloped = (result: object) => ({
    code: 0,
    message: 'ok',
    data: { result },
  })
  const bare = (body: object) => body

  const windows: Record<
    string,
    {
      provider: ProviderName
      window: number
      answers: object
      wrap: (body: object) => object
    }
  > = {
    'error: codiv counting its whole window is taken as a cut state': {
      provider: 'codiv',
      window: 65536,
      answers: ANSWERS,
      wrap: bare,
    },
    "error: decisions-api.dev counting Jev's whole window is taken as a cut state":
      {
        provider: 'decisions-api-dev',
        window: 64000,
        answers: { q0: ANSWERS.call_t1 },
        wrap: enveloped,
      },
    "error: decisionapi.net counting Jev's whole window is taken as a cut state":
      {
        provider: 'decisionapi-net',
        window: 64000,
        answers: ANSWERS,
        wrap: enveloped,
      },
    'error: openai counting its whole window is discarded': {
      provider: 'openai',
      window: 272000,
      answers: [{ type: 'predicate', name: 'call_t1', probability: 0.25 }],
      wrap: bare,
    },
  }

  for (const [name, { provider, window, answers, wrap }] of Object.entries(
    windows,
  )) {
    test(name, () => {
      const counting = (tokens: number) =>
        response(200, wrap({ answers, usage: { input_tokens: tokens } }))

      expect(
        replyFrom(routeOf(provider), counting(window - 1), ALL, QUESTIONS)
          .usage,
        'one token under the window is a reply',
      ).toEqual({ input_tokens: window - 1 })
      expect(() =>
        replyFrom(routeOf(provider), counting(window), ALL, QUESTIONS),
      ).toThrow({
        message:
          `${provider} counted ${window} input tokens, all that a request ` +
          `of its may hold (${window}): the state was probably cut short, ` +
          'so the answers decide nothing',
      })
    })
  }

  describe('perplexity, which counts the state once a question', () => {
    /**
     * A request of `count` questions, each with its answer.
     */
    const askedOf = (count: number) => {
      const asked: Questions = {}
      const answers: Record<string, unknown> = {}

      for (const index of Array.from({ length: count }, (_, i) => i)) {
        asked[`call_t${index}`] = { type: 'noul', instructions: 'Is it?' }
        answers[`call_t${index}`] = { type: 'noul', noul: 0.25 }
      }

      return { asked, answers }
    }
    const replying = (count: number, tokens: number) => {
      const { asked, answers } = askedOf(count)

      return replyFrom(
        routeOf('perplexity'),
        response(200, { answers, usage: { input_tokens: tokens } }),
        ALL,
        asked,
      )
    }

    test('success: 128 questions counted as 1,532,288 tokens are 11,971 a question and a reply', () => {
      expect(
        replying(128, 1_532_288).usage,
        'the count is kept as the provider billed it',
      ).toEqual({ input_tokens: 1_532_288 })
    })

    test('success: 8 questions counted as one token under the window each are a reply', () => {
      expect(replying(8, 8 * 262_142).usage).toEqual({
        input_tokens: 8 * 262_142,
      })
    })

    test('error: 8 questions counted as the whole window each are taken as a cut state', () => {
      expect(() => replying(8, 8 * 262_143)).toThrow({
        message:
          'perplexity counted 262143 input tokens a question, all that a ' +
          'request of its may hold (262143): the state was probably cut ' +
          'short, so the answers decide nothing',
      })
    })

    test('error: one question counted as the whole window is taken as a cut state', () => {
      expect(() => replying(1, 262_143)).toThrow({
        message:
          'perplexity counted 262143 input tokens a question, all that a ' +
          'request of its may hold (262143): the state was probably cut ' +
          'short, so the answers decide nothing',
      })
    })
  })

  for (const provider of ['decisions-api-dev', 'decisionapi-net'] as const) {
    test(`success: ${provider} counting more tokens than 32 KiB of English is not taken as a cut state`, () => {
      // A body near the byte cap written in CJK counts about a token a
      // character, so 9,000 tokens fit in 32 KiB and the state was read whole.
      const answers =
        provider === 'decisions-api-dev' ? { q0: ANSWERS.call_t1 } : ANSWERS
      const reply = replyFrom(
        routeOf(provider),
        response(200, enveloped({ answers, usage: { input_tokens: 9000 } })),
        ALL,
        QUESTIONS,
      )

      expect(reply.usage).toEqual({ input_tokens: 9000 })
    })
  }
})

describe('redacted', () => {
  const texts: Record<string, { text: string; expected: string }> = {
    'success: a text without a credential is unchanged': {
      text: 'typesafe answered HTTP 500: no reason given',
      expected: 'typesafe answered HTTP 500: no reason given',
    },
    'success: every occurrence of every secret is replaced': {
      text: 'test-typesafe-key, test-openrouter-key, test-typesafe-key and test-cloudflare-token',
      expected: '[redacted], [redacted], [redacted] and [redacted]',
    },
    'success: the scheme goes with the token after it': {
      text: 'Authorization: Bearer abc.def-123_~+/= rejected',
      expected: 'Authorization: [redacted] rejected',
    },
    'success: the scheme is matched whatever its case and spacing': {
      text: 'BEARER\n  xyz and bearer\tqrs',
      expected: '[redacted] and [redacted]',
    },
    'success: a quoted header keeps the quote that closes it': {
      text: '{"authorization":"Bearer abc123"}',
      expected: '{"authorization":"[redacted]"}',
    },
    'success: a scheme written as a field with a colon goes with its token': {
      text: 'sent Bearer: abc123 and BEARER : def456',
      expected: 'sent [redacted] and [redacted]',
    },
    'success: a scheme written as a field with an equals sign goes with its token':
      {
        text: 'query bearer=abc123&x=1 and Bearer = def456',
        expected: 'query [redacted] and [redacted]',
      },
    'success: the account id is not a secret': {
      text: 'account test-account not found',
      expected: 'account test-account not found',
    },
  }

  for (const [name, { text, expected }] of Object.entries(texts)) {
    test(name, () => {
      expect(redacted(text, CREDENTIALS)).toBe(expected)
    })
  }

  test('success: a secret that contains another is replaced whole', () => {
    expect(
      redacted('long test-key-extended and short test-key', {
        typesafeApiKey: 'test-key',
        openrouterApiKey: 'test-key-extended',
      }),
    ).toBe('long [redacted] and short [redacted]')
  })

  test('success: a resolved value too short to be a key is not replaced where it stands', () => {
    const credentials = { typesafeApiKey: 'abc1234' }

    expect(redacted('the tabc1234 key and abc1234 here', credentials)).toBe(
      'the tabc1234 key and abc1234 here',
    )
    expect(
      redacted('Authorization: Bearer abc1234', credentials),
      'after the scheme it is still taken out',
    ).toBe('Authorization: [redacted]')
  })

  test('success: a value of exactly the shortest length is replaced', () => {
    expect(redacted('k=12345678;', { openrouterApiKey: '12345678' })).toBe(
      'k=[redacted];',
    )
  })

  test('success: with no credential resolved a bearer token is still taken out', () => {
    expect(redacted('sent Bearer abc', {})).toBe('sent [redacted]')
  })

  test('success: every key of every provider is taken out of a text', () => {
    expect(
      redacted(
        'test-codiv-key test-perplexity-key test-decisions-key ' +
          'test-decisionapi-key test-openai-key test-typesafe-key ' +
          'Authorization: Bearer sk-anything',
        ALL,
      ),
    ).toBe(
      '[redacted] [redacted] [redacted] [redacted] [redacted] [redacted] ' +
        'Authorization: [redacted]',
    )
  })
})

describe('isRetryable', () => {
  const statuses: Record<string, [number, boolean]> = {
    'success: 429 is retried': [429, true],
    'success: 529 is retried': [529, true],
    'success: 500 is retried': [500, true],
    'success: 503 is retried': [503, true],
    'success: 401 is final': [401, false],
    'success: 422 is final': [422, false],
    'success: 404 is final': [404, false],
  }

  for (const [name, [status, expected]] of Object.entries(statuses)) {
    test(name, () => {
      expect(isRetryable(status)).toBe(expected)
    })
  }
})

describe('credentials', () => {
  test('success: an option wins over the environment, which wins over settings', () => {
    const environment = environmentOf(
      { TYPESAFE_API_KEY: 'test-from-env', OPENROUTER_API_KEY: 'test-or-env' },
      {
        TYPESAFE_API_KEY: 'test-from-settings',
        CLOUDFLARE_API_TOKEN: 'test-cf-settings',
        UNRELATED: 'ignored',
      },
    )

    expect(environment).toEqual({
      TYPESAFE_API_KEY: 'test-from-env',
      OPENROUTER_API_KEY: 'test-or-env',
      CLOUDFLARE_API_TOKEN: 'test-cf-settings',
      CLOUDFLARE_ACCOUNT_ID: undefined,
    })
    expect(
      credentialsOf({ openrouterApiKey: 'test-or-option' }, environment),
    ).toEqual({
      typesafeApiKey: 'test-from-env',
      openrouterApiKey: 'test-or-option',
      cloudflareApiToken: 'test-cf-settings',
    })
  })

  test('success: blank values and a settings env that is no object count as unset', () => {
    const environment = environmentOf(
      { TYPESAFE_API_KEY: '  ' },
      'not an object',
    )

    expect(credentialsOf({ typesafeApiKey: '' }, environment)).toEqual({})
    expect(missingOf('typesafe', {})).toEqual(['TYPESAFE_API_KEY'])
    expect(
      missingOf('cloudflare', { cloudflareAccountId: 'test-account' }),
    ).toEqual(['CLOUDFLARE_API_TOKEN'])
    expect(
      missingOf('openrouter', { openrouterApiKey: 'test-openrouter-key' }),
    ).toEqual([])
  })

  test('success: all nine variables are read from the environment and the settings', () => {
    const environment = environmentOf(
      {
        CODIV_API_KEY: 'test-codiv-env',
        OPENAI_API_KEY: 'test-openai-env',
      },
      {
        PERPLEXITY_API_KEY: 'test-perplexity-settings',
        DECISIONS_API_KEY: 'test-decisions-settings',
        DECISIONAPI_API_KEY: 'test-decisionapi-settings',
        OPENAI_API_KEY: 'test-openai-settings',
      },
    )

    expect(Object.keys(environment).sort()).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'CODIV_API_KEY',
      'DECISIONAPI_API_KEY',
      'DECISIONS_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'PERPLEXITY_API_KEY',
      'TYPESAFE_API_KEY',
    ])
    expect(
      credentialsOf({ decisionsApiKey: 'test-decisions-option' }, environment),
    ).toEqual({
      codivApiKey: 'test-codiv-env',
      perplexityApiKey: 'test-perplexity-settings',
      decisionsApiKey: 'test-decisions-option',
      decisionapiApiKey: 'test-decisionapi-settings',
      openaiApiKey: 'test-openai-env',
    })
  })

  test('success: only the credentials of the providers that may be called are kept', () => {
    expect(credentialsFor(['typesafe', 'openai'], ALL)).toEqual({
      typesafeApiKey: 'test-typesafe-key',
      openaiApiKey: 'test-openai-key',
    })
    expect(credentialsFor(['cloudflare'], ALL)).toEqual({
      cloudflareApiToken: 'test-cloudflare-token',
      cloudflareAccountId: 'test-account',
    })
    expect(credentialsFor(['codiv'], CREDENTIALS)).toEqual({})
  })

  const unresolved: Record<
    string,
    {
      providers: ProviderName[]
      options: Record<string, string>
      read: Record<string, string>
      expected: string[]
    }
  > = {
    'success: both cloudflare values in the environment leave nothing to look for':
      {
        providers: ['cloudflare'],
        options: {},
        read: {
          CLOUDFLARE_API_TOKEN: 'test-cloudflare-token',
          CLOUDFLARE_ACCOUNT_ID: 'test-account',
        },
        expected: [],
      },
    'success: a key given as an option leaves nothing to look for': {
      providers: ['typesafe'],
      options: { typesafeApiKey: 'test-typesafe-key' },
      read: {},
      expected: [],
    },
    'success: a provider that is not in play is not looked for': {
      providers: ['typesafe'],
      options: {},
      read: { TYPESAFE_API_KEY: 'test-typesafe-key' },
      expected: [],
    },
    'success: the key of the one provider in play is named when absent': {
      providers: ['openrouter'],
      options: {},
      read: { TYPESAFE_API_KEY: 'test-typesafe-key' },
      expected: ['OPENROUTER_API_KEY'],
    },
    'success: every provider in play is checked, each variable once': {
      providers: ['typesafe', 'cloudflare', 'openrouter', 'cloudflare'],
      options: { cloudflareAccountId: 'test-account' },
      read: { OPENROUTER_API_KEY: 'test-openrouter-key' },
      expected: ['TYPESAFE_API_KEY', 'CLOUDFLARE_API_TOKEN'],
    },
    'success: a key needed by a provider in play is looked for in the settings':
      {
        providers: ['typesafe', 'openai'],
        options: {},
        read: { TYPESAFE_API_KEY: 'test-typesafe-key' },
        expected: ['OPENAI_API_KEY'],
      },
  }

  for (const [name, { providers, options, read, expected }] of Object.entries(
    unresolved,
  )) {
    test(name, () => {
      expect(unresolvedOf(providers, options, read)).toEqual(expected)
    })
  }
})

describe('question ids at decisions-api.dev', () => {
  const LONG = `result_${'x'.repeat(93)}`
  const ASKED: Questions = {
    'call_toolu.01-AbC': { type: 'noul', instructions: 'Keep the call?' },
    [LONG]: { type: 'noul', instructions: 'Keep the result?' },
    route: {
      type: 'choice',
      instructions: 'Which?',
      criteria: { 'typesafe.jev-latest': 'Jev.', 'cloudflare.clef': null },
    },
  }
  const VENDOR_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

  test('success: a question asked as __proto__ is read back as an ordinary key', () => {
    const route = routeOf('decisions-api-dev')
    const asked: Questions = JSON.parse(
      '{"__proto__":{"type":"noul","instructions":"Is it?"}}',
    )
    const body = JSON.parse(exchangeOf(route, ALL, 's', asked).init.body)
    const reply = replyFrom(
      route,
      response(200, {
        code: 0,
        message: 'ok',
        data: { result: { answers: { q0: { noul: 0.4 } }, usage: {} } },
      }),
      ALL,
      asked,
    )

    expect(Object.keys(body.questions)).toEqual(['q0'])
    expect(Object.hasOwn(reply.answers, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(reply.answers)).toBe(null)
    expect(noulOf(reply, '__proto__')).toBe(0.4)
  })

  test('success: ids the vendor refuses are sent by their place and read back under their own', () => {
    const route = routeOf('decisions-api-dev')
    const body = JSON.parse(exchangeOf(route, ALL, 's', ASKED).init.body)

    expect(LONG.length).toBe(100)
    expect(Object.keys(body.questions)).toEqual(['q0', 'q1', 'q2'])
    expect(Object.keys(body.questions).every(id => VENDOR_ID.test(id))).toBe(
      true,
    )
    expect(body.questions.q2.criteria, 'option names are kept').toEqual({
      'typesafe.jev-latest': 'Jev.',
      'cloudflare.clef': null,
    })

    const reply = replyFrom(
      route,
      response(200, {
        code: 0,
        message: 'ok',
        data: {
          result: {
            answers: {
              q1: { type: 'noul', noul: 0.2 },
              q0: { type: 'noul', noul: 0.7 },
              q2: {
                type: 'choice',
                choice: 'cloudflare.clef',
                confidence: 0.6,
              },
            },
            usage: { input_tokens: 300, output_tokens: 3 },
          },
        },
      }),
      ALL,
      ASKED,
    )

    expect(noulOf(reply, 'call_toolu.01-AbC')).toBe(0.7)
    expect(noulOf(reply, LONG)).toBe(0.2)
    expect(
      choiceOf(reply, 'route', ['typesafe.jev-latest', 'cloudflare.clef']),
    ).toEqual({ choice: 'cloudflare.clef', confidence: 0.6 })
  })

  test('error: an answer under a place that was not asked is refused', () => {
    expect(() =>
      replyFrom(
        routeOf('decisions-api-dev'),
        response(200, {
          code: 0,
          message: 'ok',
          data: { result: { answers: { q3: { noul: 0.5 } }, usage: {} } },
        }),
        ALL,
        ASKED,
      ),
    ).toThrow({
      message: 'decisions-api-dev: answered q3, which was not asked',
    })
  })

  test('success: decisionapi.net, which accepts the ids, is sent them as they are', () => {
    const body = JSON.parse(
      exchangeOf(routeOf('decisionapi-net'), ALL, 's', ASKED).init.body,
    )

    expect(Object.keys(body.questions)).toEqual([
      'call_toolu.01-AbC',
      LONG,
      'route',
    ])
  })
})

describe('openai answers', () => {
  const ASKED: Questions = {
    call_t1: { type: 'noul', instructions: 'Keep it?' },
    flag: {
      type: 'choice',
      instructions: 'Which?',
      criteria: { true: null, false: null },
    },
  }

  test('error: a refusal is named by its question', () => {
    expect(() =>
      replyFrom(
        routeOf('openai'),
        response(200, {
          answers: [
            { type: 'refusal', name: 'call_t1', refusal: 'I cannot help.' },
          ],
        }),
        ALL,
        ASKED,
      ),
    ).toThrow({ message: 'openai: refused to answer call_t1' })
  })

  test('success: a boolean pick reads as the option offered as that text', () => {
    const reply = replyFrom(
      routeOf('openai'),
      response(200, {
        answers: [
          { type: 'choice', name: 'flag', choice: false, confidence: 0.9 },
        ],
      }),
      ALL,
      ASKED,
    )

    expect(choiceOf(reply, 'flag', ['true', 'false'])).toEqual({
      choice: 'false',
      confidence: 0.9,
    })
    expect(() => choiceOf(reply, 'flag', ['yes', 'no'])).toThrow({
      message: 'no offered option was answered for flag',
    })
  })
})
