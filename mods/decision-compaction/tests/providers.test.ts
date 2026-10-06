import { describe, expect, test } from 'claude-code/testing'

import {
  credentialsOf,
  environmentOf,
  exchangeOf,
  isRetryable,
  limitsOf,
  missingOf,
  modelsOf,
  providerOf,
  redacted,
  MIN_SECRET_CHARS,
  REDACTED,
  replyFrom,
  routeOf,
  unresolvedOf,
} from '../hooks/providers'
import type { Credentials, Route } from '../hooks/providers'

const CREDENTIALS: Credentials = {
  typesafeApiKey: 'test-typesafe-key',
  openrouterApiKey: 'test-openrouter-key',
  cloudflareApiToken: 'test-cloudflare-token',
  cloudflareAccountId: 'test-account',
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
  }

  for (const [name, { route, has, message }] of Object.entries(unconfigured)) {
    test(name, () => {
      expect(() => exchangeOf(route, has, 's', QUESTIONS)).toThrow({ message })
    })
  }
})

describe('routeOf', () => {
  test('error: a model cloudflare does not serve is refused before any request', () => {
    expect(() => routeOf('cloudflare', 'jev-latest')).toThrow(
      'cloudflare serves clef and clef-flash, not "jev-latest"',
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
  test('success: each provider states its documented limits', () => {
    expect(limitsOf(routeOf('typesafe'))).toEqual({
      maxStateTokens: 32000,
      maxRequestTokens: 64000,
    })
    expect(limitsOf(routeOf('openrouter'))).toEqual({
      maxStateTokens: 32000,
      maxRequestTokens: 32000,
    })
    expect(limitsOf(routeOf('cloudflare'))).toEqual({
      maxStateTokens: 65536,
      maxRequestTokens: 65536,
      maxQuestions: 64,
    })
  })

  const gateway: Record<string, { model: string; maxQuestions?: number }> = {
    'success: clef over openrouter takes at most 64 questions': {
      model: 'cloudflare/clef',
      maxQuestions: 64,
    },
    'success: clef-flash over openrouter takes at most 64 questions': {
      model: 'cloudflare/clef-flash',
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

  for (const [name, { model, maxQuestions }] of Object.entries(gateway)) {
    test(name, () => {
      const expected: Record<string, number> = {
        maxStateTokens: 32000,
        maxRequestTokens: 32000,
      }

      if (maxQuestions !== undefined) {
        expected.maxQuestions = maxQuestions
      }

      expect(limitsOf(routeOf('openrouter', model))).toEqual(expected)
    })
  }

  test('success: only cloudflare offers two models', () => {
    expect(modelsOf('cloudflare')).toEqual(['clef', 'clef-flash'])
    expect(modelsOf('typesafe')).toEqual(['jev-latest'])
    expect(modelsOf('openrouter')).toEqual(['~typesafe/jev-latest'])
  })

  test('success: only a listed name is a provider', () => {
    expect(providerOf('cloudflare')).toBe('cloudflare')
    expect(providerOf('openai')).toBeUndefined()
    expect(providerOf(undefined)).toBeUndefined()
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
    )

    expect(reply).toEqual({
      model: 'jev-1.13.0',
      answers: ANSWERS,
      usage: { input_tokens: 296, output_tokens: 20 },
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
    )

    expect(reply.usage).toEqual({
      cost: 0.000019992,
      input_tokens: 476,
      output_tokens: 70,
    })
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
    )

    expect(reply).toEqual({
      model: 'clef',
      answers: ANSWERS,
      usage: { input_tokens: 9, output_tokens: 1 },
    })
  })

  test('success: a bare cloudflare body is read without an envelope', () => {
    const reply = replyFrom(
      routeOf('cloudflare'),
      response(200, { answers: ANSWERS }),
      CREDENTIALS,
    )

    expect(reply).toEqual({ answers: ANSWERS, usage: {} })
  })

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
      message:
        'cloudflare: the response envelope reports failure: ' +
        `capacity ${'m'.repeat(151)}…`,
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
    'error: a cloudflare count of input tokens at its limit is refused': {
      route: routeOf('cloudflare'),
      status: 200,
      payload: {
        success: true,
        result: { answers: ANSWERS, usage: { input_tokens: 65536 } },
      },
      message:
        'cloudflare counted 65536 input tokens, all that a request of its ' +
        'may hold (65536): the state was probably cut short, so the answers ' +
        'decide nothing',
    },
  }

  for (const [name, { route, status, payload, message }] of Object.entries(
    failures,
  )) {
    test(name, () => {
      expect(() =>
        replyFrom(route, response(status, payload), CREDENTIALS),
      ).toThrow({ message })
    })
  }

  test('success: a count of input tokens one under the limit is a reply', () => {
    expect(
      replyFrom(
        routeOf('openrouter'),
        response(200, { answers: ANSWERS, usage: { input_tokens: 31999 } }),
        CREDENTIALS,
      ).usage,
    ).toEqual({ input_tokens: 31999 })
  })

  /**
   * The message thrown for an error body, whatever it is.
   */
  function messageFor(body: string): string {
    try {
      replyFrom(routeOf('typesafe'), response(422, body), CREDENTIALS)
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
    const credentials = { typesafeApiKey: 'ab12' }

    expect(MIN_SECRET_CHARS).toBe(8)
    expect(redacted('the tab12 key and ab12 here', credentials)).toBe(
      'the tab12 key and ab12 here',
    )
    expect(
      redacted('Authorization: Bearer ab12', credentials),
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
    expect(REDACTED.toLowerCase().includes('bearer')).toBe(false)
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

  const unresolved: Record<
    string,
    {
      providers: ('typesafe' | 'openrouter' | 'cloudflare')[]
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
  }

  for (const [name, { providers, options, read, expected }] of Object.entries(
    unresolved,
  )) {
    test(name, () => {
      expect(unresolvedOf(providers, options, read)).toEqual(expected)
    })
  }
})
