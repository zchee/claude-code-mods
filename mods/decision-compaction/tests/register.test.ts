import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { estimatedTokensOf } from '../hooks/state'
import type { State } from '../hooks/state'
import {
  ADDED_ENV,
  ALL_ENV,
  answering,
  calling,
  CLOUDFLARE_URL,
  CODIV_URL,
  DECISIONAPI_URL,
  DECISIONS_URL,
  ENGINE_MESSAGES,
  ENV,
  OPENAI_URL,
  OPENROUTER_URL,
  PERPLEXITY_URL,
  readsOf,
  responseOf,
  said,
  scoring,
  sessionOf,
  SUMMARY,
  TYPESAFE_URL,
  withOutcomes,
  worldOf,
} from './fixtures'
import type { Answerer, Setup, World } from './fixtures'

/**
 * Two recent messages pinned: of the session's four calls, three are asked
 * about.
 */
const OPTIONS = { preserveRecentMessages: 2 }

/**
 * Truncate the Read's result, drop the failed Bash call, keep the Grep.
 */
const DECIDED = scoring({ t1: [0.9, 0.1], t2: [0.1, 0.1], t3: [0.9, 0.9] })

/**
 * `DECIDED`, read off what a question asks instead of its id: a provider
 * that names questions by their place sends ids that say nothing of the
 * call.
 */
const DECIDED_BY_TEXT: Answerer = (id, question, seen) => {
  const call = /tool call (\S+) \(/.exec(question.instructions)?.[1]
  const kind = question.instructions.startsWith('Does the complete output')
    ? 'result'
    : 'call'

  return DECIDED(
    call === undefined ? id : `${kind}_${call}`,
    question,
    seen,
  )
}

/**
 * The handles of the session once `DECIDED` is applied: the Read's result
 * is rebuilt, the Bash call and its result are gone.
 */
const DECIDED_HANDLES = [
  'h0',
  'h1',
  undefined,
  'h5',
  'h6',
  'h7',
  'h8',
  'h9',
  'h10',
]

const ALL_HANDLES = [
  'h0',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'h7',
  'h8',
  'h9',
  'h10',
]

const CUT_READ =
  `${'r'.repeat(300)}\n[decision-compaction removed 4700 more characters of ` +
  'this tool output; run the tool again if they are needed]'

/**
 * Why codiv, perplexity, decisions-api-dev, decisionapi-net and openai are
 * each ruled out when none of their keys is set, as a list of refusals
 * spells them and in the order they are considered.
 */
const ADDED_UNSET =
  'codiv/openjev-latest: CODIV_API_KEY unset; ' +
  'perplexity/pplx-decider-v1.1-27b: PERPLEXITY_API_KEY unset; ' +
  'decisions-api-dev/jev-latest: DECISIONS_API_KEY unset; ' +
  'decisionapi-net/jev-latest: DECISIONAPI_API_KEY unset; ' +
  'openai/gpt-6-luna: OPENAI_API_KEY unset'

/**
 * Ordinary English prose of about `chars` characters: words of a few
 * letters a space apart, which the token estimate counts at far fewer
 * tokens than bytes.
 */
function proseOf(chars: number): string {
  const sentences = [
    'The parser reads each line of the file and checks whether the next ' +
      'word starts a new statement or continues the one before it.',
    'When the test fails, the assistant looks at the stack trace first and ' +
      'then opens the module that raised the error.',
    'Most of the time the problem is a missing import or a typo in a name ' +
      'that the compiler did not catch.',
    'After the change the whole suite runs again, and the result is ' +
      'compared with the one from before the edit.',
  ]
  let text = ''

  for (let at = 0; text.length < chars; at++) {
    text += `${sentences[at % sentences.length]} `
  }

  return text.trim()
}

/**
 * `sessionOf` with `count` old assistant messages of `chars` characters of
 * English prose each after its first message, handled `p1`, `p2`, …: a
 * session that talks more than it calls tools.
 */
function englishSessionOf(count: number, chars: number): SessionMessage[] {
  const [first, ...rest] = sessionOf()
  const prose = Array.from({ length: count }, (_, at) =>
    calling(proseOf(chars), [], `p${at + 1}`),
  )

  return first === undefined ? rest : [first, ...prose, ...rest]
}

function handlesOf(messages: readonly SessionMessage[] | undefined) {
  return messages?.map(message => message.handle)
}

/**
 * Asserts no credential, and no word that announces one, reached a line the
 * person can read: every toast and every line of the transcript.
 */
function expectNoSecret(world: World) {
  for (const text of [...world.toasts, ...world.lines]) {
    for (const secret of [
      ENV.TYPESAFE_API_KEY,
      ENV.OPENROUTER_API_KEY,
      ENV.CLOUDFLARE_API_TOKEN,
      ...Object.values(ADDED_ENV),
      'bearer',
    ]) {
      expect(
        text.toLowerCase().includes(secret),
        `${JSON.stringify(secret)} is shown in: ${text}`,
      ).toBe(false)
    }
  }
}

/**
 * A response whose body is not JSON, as a proxy in front of a provider
 * answers.
 */
function pageOf(status: number, text: string) {
  return { status, ok: status >= 200 && status < 300, headers: {}, text }
}

describe('session.compact', () => {
  test(
    'success: decisions hand back the conversation itself in place of the summary',
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: DECIDED })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })
      const [seen] = world.requests
      const state = seen?.state as State

      expect(world.problems).toEqual([])
      expect(world.requests).toHaveLength(1)
      expect(seen?.url).toBe(TYPESAFE_URL)
      expect(seen?.model).toBe('jev-latest')
      expect(
        Object.keys(seen?.questions ?? {}),
        'the pinned call is not asked about',
      ).toEqual([
        'call_t1',
        'result_t1',
        'call_t2',
        'result_t2',
        'call_t3',
        'result_t3',
      ])
      expect(state.goal).toBe('Fix the failing test in src/a.ts\nNow fix it')
      expect(state.conversation.map(entry => entry.at)).toEqual([
        0, 1, 3, 5, 7, 8, 9,
      ])
      expect(state.conversation[1]).toEqual({
        at: 1,
        role: 'assistant',
        text: 'Reading the file.',
        calls: [
          {
            id: 't1',
            tool: 'Read',
            input: '{"file_path":"src/a.ts"}',
            result: 'ok, 5000 characters, not shown',
          },
        ],
      })
      expect(
        JSON.stringify(state).includes('rrrr'),
        'no tool output is sent',
      ).toBe(false)

      expect(world.builtIn, 'the built-in summary did not run').toEqual([])
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(out.messages?.[2]).toEqual({
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'u1', text: CUT_READ, isError: false }],
      })
      expect(
        out.messages?.some(message =>
          message.toolUses.some(use => use.tool_use_id === 'u2'),
        ),
      ).toBe(false)

      // Texts 96, tool inputs 90 and results 12002 characters before; the
      // Bash call (4000 + 22) is gone and the Read result is cut to CUT_READ.
      const before = 96 + 90 + 12002
      const after = before - 4022 - 5000 + CUT_READ.length
      const smaller = Math.round(((before - after) / before) * 100)
      const said =
        'compacted without a summary: 9 of 11 messages remain ' +
        `(${smaller}% smaller; tool calls: 1 left whole, 1 with the result ` +
        'cut short, 1 removed, 1 not judged; typesafe/jev-latest ' +
        `in 1 request; state about ${estimatedTokensOf(JSON.stringify(state))} ` +
        'tokens estimated (whole), 1234 input tokens counted by the provider)'

      expect(world.toasts).toEqual([said])
      expect(world.lines).toEqual([
        'per-call verdicts: t1 Read -> truncate (call 0.90, result 0.10); ' +
          't2 Bash -> drop (call 0.10, result 0.10); ' +
          't3 Grep -> keep (call 0.90, result 0.90)',
        said,
      ])
      expect(
        world.settingsReads,
        'the environment had the key, so the settings were left alone',
      ).toBe(0)
      expectNoSecret(world)
    },
  )

  const providers: Record<
    string,
    {
      options: Record<string, string | number>
      setup?: Setup
      url: string
      model: string
      said: string
      settingsReads?: number
    }
  > = {
    'success: cloudflare is asked through its account URL and its envelope is read':
      {
        options: { ...OPTIONS, provider: 'cloudflare' },
        url: `${CLOUDFLARE_URL}clef`,
        model: 'clef',
        said: 'cloudflare/clef in 1 request',
      },
    'success: a cloudflare catalogue id selects clef-flash': {
      options: {
        ...OPTIONS,
        provider: 'cloudflare',
        model: '@cf/cloudflare/clef-flash',
      },
      url: `${CLOUDFLARE_URL}clef-flash`,
      model: 'clef-flash',
      said: 'cloudflare/clef-flash in 1 request',
    },
    'success: openrouter is asked for its alias of the newest jev and its cost is reported':
      {
        options: { ...OPTIONS, provider: 'openrouter' },
        url: OPENROUTER_URL,
        model: '~typesafe/jev-latest',
        said: 'openrouter/~typesafe/jev-latest in 1 request',
      },
    'success: a bare jev id is sent to openrouter as written': {
      options: { ...OPTIONS, provider: 'openrouter', model: 'jev-latest' },
      url: OPENROUTER_URL,
      model: 'jev-latest',
      said: 'openrouter/jev-latest in 1 request',
    },
    'success: a configured model is sent to typesafe': {
      options: { ...OPTIONS, model: 'jev-1.13.0' },
      url: TYPESAFE_URL,
      model: 'jev-1.13.0',
      said: 'typesafe/jev-1.13.0 in 1 request',
    },
    'success: a key given as a plugin option needs no environment': {
      options: { ...OPTIONS, typesafeApiKey: ENV.TYPESAFE_API_KEY },
      setup: { env: {} },
      url: TYPESAFE_URL,
      model: 'jev-latest',
      said: 'typesafe/jev-latest in 1 request',
    },
    'success: a key in the settings env block is found': {
      options: { ...OPTIONS, provider: 'openrouter' },
      setup: {
        env: {},
        settingsEnv: { OPENROUTER_API_KEY: ENV.OPENROUTER_API_KEY },
      },
      url: OPENROUTER_URL,
      model: '~typesafe/jev-latest',
      said: 'openrouter/~typesafe/jev-latest in 1 request',
      settingsReads: 1,
    },
    'success: a key missing for a provider that is not in play costs no read of the settings':
      {
        options: { ...OPTIONS, provider: 'cloudflare' },
        setup: {
          env: {
            CLOUDFLARE_API_TOKEN: ENV.CLOUDFLARE_API_TOKEN,
            CLOUDFLARE_ACCOUNT_ID: ENV.CLOUDFLARE_ACCOUNT_ID,
          },
          settingsFails: 'the settings are not to be read',
        },
        url: `${CLOUDFLARE_URL}clef`,
        model: 'clef',
        said: 'cloudflare/clef in 1 request',
      },
  }

  for (const [
    name,
    { options, setup, url, model, said, settingsReads },
  ] of Object.entries(providers)) {
    test(name, { options }, async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: DECIDED, ...setup })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(world.problems).toEqual([])
      expect(world.requests.map(seen => [seen.url, seen.model])).toEqual([
        [url, model],
      ])
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.builtIn).toEqual([])
      expect(world.toasts).toHaveLength(1)
      expect(world.toasts[0]).toContain(said)
      expect(world.toasts[0]?.includes('cost $0.000050')).toBe(
        url === OPENROUTER_URL,
      )
      expect(world.settingsReads).toBe(settingsReads ?? 0)
      expectNoSecret(world)
    })
  }

  test(
    'success: cloudflare gets at most 64 questions a request',
    { options: { provider: 'cloudflare', preserveRecentMessages: 0 } },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: () => 0.1 })
      const out = await $.session.compact({
        trigger: 'auto',
        messages: readsOf(40),
      })

      expect(world.problems).toEqual([])
      expect(
        world.requests
          .map(seen => Object.keys(seen.questions).length)
          .sort((a, b) => b - a),
      ).toEqual([64, 16])
      expect(
        new Set(world.requests.map(seen => JSON.stringify(seen.state))).size,
        'one state for every batch',
      ).toBe(1)
      expect(handlesOf(out.messages)).toEqual(['first', 'last'])
      expect(world.toasts[0]).toContain(
        'compacted without a summary: 2 of 82 messages remain (',
      )
      expect(world.toasts[0]).toContain(
        'tool calls: 40 removed; cloudflare/clef in 2 requests',
      )
    },
  )

  test(
    'success: the same session reaches typesafe in one request',
    { options: { preserveRecentMessages: 0 } },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: () => 0.1 })

      await $.session.compact({ trigger: 'auto', messages: readsOf(40) })

      expect(
        world.requests.map(seen => Object.keys(seen.questions).length),
      ).toEqual([80])
    },
  )

  test(
    'success: the instructions given with the compaction are sent as the goal',
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: DECIDED })

      await $.session.compact({
        trigger: 'manual',
        instructions: 'keep everything about the parser',
        messages: sessionOf(),
      })

      expect((world.requests[0]?.state as State).goal).toBe(
        'keep everything about the parser',
      )
    },
  )

  for (const trigger of ['manual', 'auto', 'plugin'] as const) {
    test(
      `success: a ${trigger} compaction is decided`,
      { options: OPTIONS },
      async ($, on) => {
        const world = worldOf(on, { env: ENV, answer: DECIDED })
        const out = await $.session.compact({ trigger, messages: sessionOf() })

        expect(world.requests).toHaveLength(1)
        expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      },
    )
  }

  test(
    "success: a subagent's compaction is decided like the main one",
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: DECIDED })
      const out = await $.session.compact({
        trigger: 'auto',
        agentId: 'agent-7',
        messages: sessionOf(),
      })

      expect(world.requests).toHaveLength(1)
      expect(world.builtIn).toEqual([])
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
    },
  )

  test(
    'success: a precompute is left to the engine, unasked and unannounced',
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: DECIDED })
      const out = await $.session.compact({
        trigger: 'precompute',
        messages: sessionOf(),
      })

      expect(out.messages).toEqual([SUMMARY])
      expect(world.builtIn.map(e => e.trigger)).toEqual(['precompute'])
      expect(world.requests).toEqual([])
      expect(world.toasts).toEqual([])
      expect(world.lines).toEqual([])
    },
  )

  const failOpen: Record<
    string,
    {
      options?: Record<string, string | number>
      setup: Setup
      requests: number
      said: string | RegExp
    }
  > = {
    'error: a JSON error body that repeats the key falls back without showing it':
      {
        setup: {
          env: ENV,
          intercept: () =>
            responseOf(401, {
              error: {
                message: `Invalid API key ${ENV.TYPESAFE_API_KEY}, sent as Bearer ${ENV.TYPESAFE_API_KEY}`,
              },
            }),
        },
        requests: 1,
        said:
          'built-in summary used instead: typesafe answered HTTP 401: ' +
          'Invalid API key [redacted], sent as [redacted]',
      },
    'error: an HTML error page that repeats the header falls back without showing it':
      {
        setup: {
          env: ENV,
          intercept: () =>
            pageOf(
              403,
              '<html><body><h1>403 Forbidden</h1>\n<pre>authorization: ' +
                `Bearer ${ENV.TYPESAFE_API_KEY}</pre></body></html>`,
            ),
        },
        requests: 1,
        said:
          'built-in summary used instead: typesafe answered HTTP 403: ' +
          '<html><body><h1>403 Forbidden</h1> <pre>authorization: ' +
          '[redacted]</pre></body></html>',
      },
    'error: a cloudflare failure envelope that repeats the token falls back without showing it':
      {
        options: { provider: 'cloudflare' },
        setup: {
          env: ENV,
          intercept: () =>
            responseOf(200, {
              result: null,
              success: false,
              errors: [
                { message: `token ${ENV.CLOUDFLARE_API_TOKEN} has no access` },
              ],
            }),
        },
        requests: 1,
        said:
          'built-in summary used instead: cloudflare: the response envelope ' +
          'reports failure: token [redacted] has no access',
      },
    'error: a count of input tokens at the request limit falls back': {
      setup: {
        env: ENV,
        intercept: seen =>
          responseOf(200, {
            model: 'jev-1.13.0',
            answers: Object.fromEntries(
              Object.keys(seen.questions).map(id => [
                id,
                { type: 'noul', noul: 0.1 },
              ]),
            ),
            usage: { input_tokens: 64000, output_tokens: 20 },
          }),
      },
      requests: 1,
      said:
        'built-in summary used instead: typesafe counted 64000 input ' +
        'tokens, all that a request of its may hold (64000): the state was ' +
        'probably cut short, so the answers decide nothing',
    },
    'error: settings that cannot be read leave a missing key missing': {
      setup: { env: {}, settingsFails: 'the settings file is not valid JSON' },
      requests: 0,
      said: 'built-in summary used instead: typesafe is not configured: TYPESAFE_API_KEY is unset',
    },
    'error: a missing key falls back without a request': {
      setup: { env: {} },
      requests: 0,
      said: 'built-in summary used instead: typesafe is not configured: TYPESAFE_API_KEY is unset',
    },
    'error: a missing cloudflare account id falls back without a request': {
      options: { provider: 'cloudflare' },
      setup: { env: { CLOUDFLARE_API_TOKEN: ENV.CLOUDFLARE_API_TOKEN } },
      requests: 0,
      said: 'built-in summary used instead: cloudflare is not configured: CLOUDFLARE_ACCOUNT_ID is unset',
    },
    "error: an HTTP 401 falls back with the provider's reason": {
      setup: {
        env: ENV,
        intercept: () =>
          responseOf(401, { error: { message: 'Invalid API key' } }),
      },
      requests: 1,
      said: 'built-in summary used instead: typesafe answered HTTP 401: Invalid API key',
    },
    'error: an answer missing from the reply falls back': {
      setup: {
        env: ENV,
        intercept: seen =>
          responseOf(200, {
            model: 'jev-1.13.0',
            answers: Object.fromEntries(
              Object.keys(seen.questions)
                .filter(id => id !== 'result_t2')
                .map(id => [id, { type: 'noul', noul: 0.1 }]),
            ),
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
      },
      requests: 1,
      said: 'built-in summary used instead: no probability from 0 to 1 was answered for result_t2',
    },
    'error: an out-of-range probability falls back': {
      setup: { env: ENV, answer: () => 1.5 },
      requests: 1,
      said: 'built-in summary used instead: no probability from 0 to 1 was answered for call_t1',
    },
    'error: a body that is not JSON falls back': {
      setup: {
        env: ENV,
        intercept: () => ({
          status: 200,
          ok: true,
          headers: {},
          text: '<html>gateway</html>',
        }),
      },
      requests: 1,
      said: 'built-in summary used instead: typesafe answered a body that is not JSON',
    },
    'error: a cloudflare envelope reporting failure falls back': {
      options: { provider: 'cloudflare' },
      setup: {
        env: ENV,
        intercept: () =>
          responseOf(200, {
            result: null,
            success: false,
            errors: [{ code: 3040, message: 'Capacity temporarily exceeded' }],
          }),
      },
      requests: 1,
      said:
        'built-in summary used instead: cloudflare: the response envelope ' +
        'reports failure: Capacity temporarily exceeded',
    },
    'error: a model cloudflare does not serve falls back without a request': {
      options: { provider: 'cloudflare', model: 'jev-latest' },
      setup: { env: ENV },
      requests: 0,
      said: 'built-in summary used instead: cloudflare serves clef, clef-flash and clef-omni, not "jev-latest"',
    },
    'error: a conversation that cannot fit the state budget falls back': {
      options: { maxStateTokens: 10 },
      setup: { env: ENV },
      requests: 0,
      said: /^built-in summary used instead: the conversation does not fit the state budget: about \d+ tokens are left after every reduction and 10 are allowed$/,
    },
    'error: a request budget with no room for a state beside the questions falls back':
      {
        options: { maxRequestTokens: 100 },
        setup: { env: ENV },
        requests: 0,
        said: /^built-in summary used instead: a request of 100 tokens has no room for a state beside the questions of 3 calls, which take about \d+$/,
      },
    'error: decisions that remove too little fall back': {
      setup: { env: ENV, answer: () => 0.9 },
      requests: 1,
      said: /^built-in summary used instead: the reduction is below the 25% minimum \(0% smaller; tool calls: 3 left whole, 1 not judged; typesafe\/jev-latest in 1 request; state about \d+ tokens estimated \(whole\), 1234 input tokens counted by the provider\)$/,
    },
    'error: results too short to cut are reported as left whole': {
      // Every result is to be cut, and none is 120 characters longer than
      // the 4,880 that would stay of it.
      options: { truncateHeadChars: 4880 },
      setup: { env: ENV, answer: scoring({ t1: [0.9, 0.1], t2: [0.9, 0.1] }) },
      requests: 1,
      said: /^built-in summary used instead: the reduction is below the 25% minimum \(0% smaller; tool calls: 3 left whole, 1 not judged; /,
    },
    'error: a reduction just under a raised minimum falls back': {
      options: { minReductionRatio: 0.9 },
      setup: { env: ENV, answer: DECIDED },
      requests: 1,
      said: /^built-in summary used instead: the reduction is below the 90% minimum \(71% smaller; /,
    },
    'error: a session with every call pinned falls back without a request': {
      options: { preserveRecentMessages: 50 },
      setup: { env: ENV },
      requests: 0,
      said: 'built-in summary used instead: the reduction is below the 25% minimum (0% smaller; tool calls: 4 not judged)',
    },
  }

  for (const [name, { options, setup, requests, said }] of Object.entries(
    failOpen,
  )) {
    test(name, { options: { ...OPTIONS, ...options } }, async ($, on) => {
      const world = worldOf(on, setup)
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(world.problems).toEqual([])
      expect(out.messages, 'the built-in summary stands').toEqual([SUMMARY])
      expect(world.builtIn).toHaveLength(1)
      expect(
        handlesOf(world.builtIn[0]?.messages),
        'it ran over the whole transcript',
      ).toEqual(ALL_HANDLES)
      expect(world.requests).toHaveLength(requests)
      expect(world.toasts).toHaveLength(1)

      if (typeof said === 'string') {
        expect(world.toasts[0]).toBe(said)
      } else {
        expect(world.toasts[0]).toMatch(said)
      }

      expect(world.lines.at(-1), 'the reason is logged too').toBe(
        world.toasts[0],
      )
      expectNoSecret(world)
    })
  }

  test(
    'success: a 429 is retried after the backoff and the decisions stand',
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        answer: DECIDED,
        intercept: (seen, count) =>
          count === 1
            ? responseOf(429, { error: { message: 'Rate limit exceeded' } })
            : undefined,
      })
      const pending = $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      await world.clock.advance(399)

      expect(world.requests, 'the retry waits out the backoff').toHaveLength(1)

      await world.clock.advance(1)

      const out = await pending

      expect(world.requests).toHaveLength(2)
      expect(world.requests[1]?.questions).toEqual(world.requests[0]?.questions)
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.builtIn).toEqual([])
    },
  )

  test(
    'error: a provider still rate limiting after two retries falls back',
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        intercept: () =>
          responseOf(429, { error: { message: 'Rate limit exceeded' } }),
      })
      const pending = $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      await world.clock.advance(400)

      expect(world.requests).toHaveLength(2)

      await world.clock.advance(1199)

      expect(world.requests).toHaveLength(2)

      await world.clock.advance(1)

      const out = await pending

      expect(world.requests, 'three attempts and no more').toHaveLength(3)
      expect(out.messages).toEqual([SUMMARY])
      expect(world.toasts).toEqual([
        'built-in summary used instead: typesafe answered HTTP 429: Rate limit exceeded',
      ])
    },
  )
})

/**
 * A session of `count` answered Read calls, each made by an assistant
 * message that also carries `words` words of text, so that the whole
 * conversation is far larger than any state budget.
 */
function wordyReadsOf(count: number, words: number): SessionMessage[] {
  const messages = [said('Read everything', 'first')]

  for (let n = 1; n <= count; n++) {
    messages.push(
      calling(
        'alpha '.repeat(words),
        [[`u${n}`, 'Read', { file_path: `src/f${n}.ts` }]],
        `call${n}`,
      ),
      answering([[`u${n}`, 'x'.repeat(600)]], `result${n}`),
    )
  }

  messages.push(said('Done reading', 'last'))

  return withOutcomes(messages)
}

/**
 * The estimated size of one request as the fake provider received it.
 */
function requestTokensOf(seen: World['requests'][number]): number {
  return estimatedTokensOf(
    JSON.stringify({
      model: seen.model,
      state: seen.state,
      questions: seen.questions,
    }),
  )
}

describe('the bounds on one compaction', () => {
  test(
    'success: a state that fills its budget still leaves every request room for sixteen calls',
    {
      options: {
        provider: 'openrouter',
        maxStateTokens: 1_000_000,
        maxRequestTokens: 1_000_000,
        preserveRecentMessages: 0,
      },
    },
    async ($, on) => {
      // 240 calls, each beside 100 words of text: about twice what the
      // state may hold, so the state is fitted right up to its budget.
      const world = worldOf(on, { env: ENV, answer: () => 0.1 })
      const out = await $.session.compact({
        trigger: 'auto',
        messages: wordyReadsOf(240, 100),
      })
      const sizes = world.requests
        .map(seen => Object.keys(seen.questions).length)
        .sort((a, b) => b - a)

      expect(world.problems).toEqual([])
      expect(world.builtIn.length, 'the decisions stood').toBe(0)
      expect(out.messages?.length, 'every call and result is gone').toBe(242)
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(480)
      expect(sizes.length <= 15, `${sizes.length} requests`).toBe(true)
      expect(
        sizes.slice(0, -1).every(size => size >= 32),
        `questions a request: ${sizes.join(', ')}`,
      ).toBe(true)
      expect(
        new Set(world.requests.map(seen => JSON.stringify(seen.state))).size,
      ).toBe(1)

      // 85% of the 32,000 tokens OpenRouter documents for a request.
      for (const seen of world.requests) {
        expect(requestTokensOf(seen) <= 27_200).toBe(true)
      }

      expect(
        world.toasts[0]?.includes('(whole)'),
        'the conversation did not fit whole, so the state is at its budget',
      ).toBe(false)
    },
  )

  test(
    'success: sixteen requests are sent when the calls fill them exactly',
    { options: { provider: 'cloudflare', preserveRecentMessages: 0 } },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: () => 0.1 })
      const out = await $.session.compact({
        trigger: 'auto',
        messages: readsOf(512),
      })

      expect(world.problems).toEqual([])
      expect(
        world.requests.map(seen => Object.keys(seen.questions).length),
      ).toEqual(Array.from({ length: 16 }, () => 64))
      expect(handlesOf(out.messages)).toEqual(['first', 'last'])
      expect(world.toasts[0]).toContain('cloudflare/clef in 16 requests')
    },
  )

  test(
    'error: a conversation that would take a seventeenth request falls back without sending any',
    { options: { provider: 'cloudflare', preserveRecentMessages: 0 } },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: () => 0.1 })
      const out = await $.session.compact({
        trigger: 'auto',
        messages: readsOf(513),
      })

      expect(out.messages).toEqual([SUMMARY])
      expect(world.fetches).toBe(0)
      expect(world.toasts).toEqual([
        'built-in summary used instead: asking about 513 tool calls would ' +
          'take 17 requests, and one compaction sends at most 16',
      ])
    },
  )

  test(
    'success: a budget raised past a limit is held to 85% of it',
    {
      options: {
        maxStateTokens: 1_000_000,
        maxRequestTokens: 1_000_000,
        preserveRecentMessages: 0,
      },
    },
    async ($, on) => {
      // Ten texts of 2,900 words are about 29,000 tokens: under the 32,000
      // TypeSafe documents for a state, over 85% of it.
      const world = worldOf(on, { env: ENV, answer: () => 0.1 })

      await $.session.compact({
        trigger: 'auto',
        messages: wordyReadsOf(10, 2900),
      })

      const [seen] = world.requests
      const state = estimatedTokensOf(JSON.stringify(seen?.state))

      expect(world.problems).toEqual([])
      expect(world.requests).toHaveLength(1)
      expect(state <= 27_200, `the state is about ${state} tokens`).toBe(true)
      expect(state > 20_000, 'no more was given up than had to be').toBe(true)
      expect(world.toasts[0]).toContain('(long texts cut in the middle)')
    },
  )

  test(
    'error: a request the host rejects falls back with its reason, redacted',
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        fetchFails: `refused by policy; authorization: Bearer ${ENV.TYPESAFE_API_KEY}`,
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(out.messages).toEqual([SUMMARY])
      expect(world.fetches, 'a rejected request is not retried').toBe(1)
      // The host puts its own words before the reason it was given.
      expect(world.toasts).toHaveLength(1)
      expect(world.toasts[0]).toMatch(
        /^built-in summary used instead: the request to typesafe failed: .*refused by policy; authorization: \[redacted\]$/,
      )
      expect(world.lines).toEqual(world.toasts)
      expectNoSecret(world)
    },
  )

  test(
    'error: a provider that never answers falls back when the deadline passes',
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, isProviderSilent: true })
      const pending = $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      await world.clock.advance(29_999)

      expect(world.fetches, 'the request is out').toBe(1)
      expect(world.toasts, 'and still waited for').toEqual([])
      expect(world.builtIn).toEqual([])

      await world.clock.advance(1)

      const out = await pending

      expect(out.messages).toEqual([SUMMARY])
      expect(world.fetches, 'a request past its deadline is not retried').toBe(
        1,
      )
      expect(world.toasts).toEqual([
        'built-in summary used instead: the requests of this compaction ' +
          'were not all answered within 30 seconds',
      ])
      expect(handlesOf(world.builtIn[0]?.messages)).toEqual(ALL_HANDLES)
    },
  )

  test(
    'error: after one batch fails for good the batches still out neither retry nor wait',
    { options: { provider: 'cloudflare', preserveRecentMessages: 0 } },
    async ($, on) => {
      // Three batches of 32 calls go out at once. The first is refused with
      // a 401; the other two are answered 429, which would be retried if the
      // compaction were still going on.
      const world = worldOf(on, {
        env: ENV,
        intercept: (seen, count) =>
          count === 1
            ? responseOf(401, { error: { message: 'Invalid token' } })
            : responseOf(429, { error: { message: 'Rate limit exceeded' } }),
      })
      const out = await $.session.compact({
        trigger: 'auto',
        messages: readsOf(96),
      })

      expect(out.messages).toEqual([SUMMARY])
      expect(world.toasts).toEqual([
        'built-in summary used instead: cloudflare answered HTTP 401: Invalid token',
      ])

      // Give any retry that was left running all the time it could want.
      await world.clock.advance(10_000)

      expect(world.fetches, 'the three batches and nothing after').toBe(3)
      expect(world.waits, 'no wait was ever started').toEqual([])
      expect(world.toasts, 'and nothing more to say').toHaveLength(1)
    },
  )

  test(
    'error: a wait under way is dropped the moment another batch fails for good',
    { options: { provider: 'cloudflare', preserveRecentMessages: 0 } },
    async ($, on) => {
      // Three batches of 32 calls go out at once. The first is answered 429
      // and waits to be retried; the second is then refused with a 401,
      // which ends the compaction while that wait is under way.
      const world = worldOf(on, {
        env: ENV,
        intercept: (seen, count) =>
          count === 1
            ? responseOf(429, { error: { message: 'Rate limit exceeded' } })
            : count === 2
              ? responseOf(401, { error: { message: 'Invalid token' } })
              : undefined,
      })
      const out = await $.session.compact({
        trigger: 'auto',
        messages: readsOf(96),
      })

      expect(out.messages).toEqual([SUMMARY])
      expect(world.toasts).toEqual([
        'built-in summary used instead: cloudflare answered HTTP 401: Invalid token',
      ])
      expect(world.waits, 'the first batch began its wait').toEqual([
        { ms: 400, hasEnded: false },
      ])

      // A wait left running would end here, and the clock would run it.
      await world.clock.advance(10_000)

      expect(world.waits, 'the wait was dropped, not run to its end').toEqual([
        { ms: 400, hasEnded: false },
      ])
      expect(world.fetches, 'and its retry is never sent').toBe(3)
    },
  )

  test(
    'error: a provider option that names no provider sends nothing anywhere',
    { options: { ...OPTIONS, provider: 'cloud-flare' } },
    async ($, on) => {
      const world = worldOf(on, { env: ENV })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(out.messages).toEqual([SUMMARY])
      expect(world.fetches).toBe(0)
      expect(world.settingsReads, 'not even a credential is looked for').toBe(0)
      expect(world.envReads, 'nor read from the environment').toEqual([])
      expect(world.toasts).toEqual([
        'built-in summary used instead: the provider option is ' +
          '"cloud-flare", which is none of typesafe, cloudflare, ' +
          'openrouter, codiv, perplexity, decisions-api-dev, ' +
          'decisionapi-net, openai',
      ])
    },
  )

  test(
    'success: a provider option left empty is the default provider',
    { options: { ...OPTIONS, provider: '' } },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: DECIDED })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(world.requests.map(seen => seen.url)).toEqual([TYPESAFE_URL])
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
    },
  )

  test(
    'error: a failure that never passed a provider is still shown without a bearer token',
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, {
        envFails: 'the environment is closed; the caller sent Bearer abc123',
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(out.messages).toEqual([SUMMARY])
      expect(world.fetches).toBe(0)
      expect(world.toasts).toHaveLength(1)
      expect(world.toasts[0]).toMatch(
        /^built-in summary used instead: .*the environment is closed; the caller sent \[redacted\]$/,
      )
      expect(world.lines).toEqual(world.toasts)
      expectNoSecret(world)
    },
  )
})

describe('provider decision', () => {
  const DECIDING = { ...OPTIONS, providerDecision: true }

  test(
    'success: a configured gateway and the direct route to its model are one model, not a choice',
    { options: { ...DECIDING, provider: 'openrouter' } },
    async ($, on) => {
      const world = worldOf(on, {
        env: {
          TYPESAFE_API_KEY: ENV.TYPESAFE_API_KEY,
          OPENROUTER_API_KEY: ENV.OPENROUTER_API_KEY,
        },
        answer: DECIDED,
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(world.problems).toEqual([])
      expect(world.requests.map(seen => [seen.url, seen.model])).toEqual([
        [OPENROUTER_URL, '~typesafe/jev-latest'],
      ])
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.lines[0]).toBe(
        'provider decision: one model is available (cloudflare/clef: ' +
          'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; ' +
          'cloudflare/clef-flash: CLOUDFLARE_API_TOKEN and ' +
          'CLOUDFLARE_ACCOUNT_ID unset; ' +
          'cloudflare/clef-omni: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; ' +
          `${ADDED_UNSET}; ` +
          'openrouter/~typesafe/jev-latest: the same model as ' +
          'typesafe/jev-latest); using the configured ' +
          'openrouter/~typesafe/jev-latest',
      )
    },
  )

  test(
    'success: a bare jev id on openrouter is not offered beside typesafe',
    { options: { ...DECIDING, provider: 'openrouter', model: 'jev-latest' } },
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        answer: (id, question, seen) =>
          id === 'route' ? 'typesafe.jev-latest' : DECIDED(id, question, seen),
      })

      await $.session.compact({ trigger: 'manual', messages: sessionOf() })

      const [routing, deciding] = world.requests

      expect(world.problems).toEqual([])
      expect(Object.keys(routing?.questions.route?.criteria ?? {})).toEqual([
        'typesafe.jev-latest',
        'cloudflare.clef',
        'cloudflare.clef-flash',
        'cloudflare.clef-omni',
      ])
      expect(deciding?.url).toBe(TYPESAFE_URL)
    },
  )

  test(
    'error: a failed routing request that repeats the token is logged without it',
    { options: DECIDING },
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        answer: DECIDED,
        intercept: seen =>
          'route' in seen.questions
            ? responseOf(401, {
                success: false,
                errors: [
                  {
                    code: 10000,
                    message: `Authentication error for Bearer ${ENV.CLOUDFLARE_API_TOKEN}`,
                  },
                ],
              })
            : undefined,
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.lines[0]).toBe(
        'provider decision: the routing request failed (cloudflare answered ' +
          'HTTP 401: Authentication error for [redacted]); using the ' +
          'configured typesafe/jev-latest',
      )
      expectNoSecret(world)
    },
  )

  test(
    'success: a route that would need more than sixteen requests is not offered',
    { options: { providerDecision: true, preserveRecentMessages: 0 } },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: () => 0.1 })
      const out = await $.session.compact({
        trigger: 'auto',
        messages: readsOf(513),
      })

      expect(world.problems).toEqual([])
      expect(handlesOf(out.messages)).toEqual(['first', 'last'])
      expect(
        [...new Set(world.requests.map(seen => seen.url))],
        'no routing request, and every call asked about at typesafe',
      ).toEqual([TYPESAFE_URL])
      expect(world.requests.length <= 16).toBe(true)
      expect(world.lines[0]).toContain(
        'cloudflare/clef: asking about 513 tool calls would take 17 ' +
          'requests, and one compaction sends at most 16',
      )
      expect(
        world.lines[0]?.startsWith('provider decision: one route is'),
      ).toBe(true)
    },
  )

  test(
    'success: settings that cannot be read are logged and the environment is used',
    { options: DECIDING },
    async ($, on) => {
      const world = worldOf(on, {
        env: { TYPESAFE_API_KEY: ENV.TYPESAFE_API_KEY },
        settingsFails: 'the settings file is not valid JSON',
        answer: DECIDED,
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(world.settingsReads).toBe(1)
      expect(world.lines[0]).toMatch(
        /^the settings could not be read \(.*the settings file is not valid JSON\); credentials are taken from the options and the environment alone$/,
      )
      expect(world.requests.map(seen => seen.url)).toEqual([TYPESAFE_URL])
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.builtIn).toEqual([])
    },
  )

  test(
    'success: several usable providers are put to clef-flash and the pick decides',
    { options: DECIDING },
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        answer: (id, question, seen) =>
          id === 'route' ? 'cloudflare.clef' : DECIDED(id, question, seen),
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })
      const [routing, deciding] = world.requests
      const profile = routing?.state as Record<string, unknown>

      expect(world.problems).toEqual([])
      expect(world.requests).toHaveLength(2)
      expect(routing?.url).toBe(`${CLOUDFLARE_URL}clef-flash`)
      expect(Object.keys(routing?.questions ?? {})).toEqual(['route'])
      expect(routing?.questions.route?.type).toBe('choice')
      expect(
        Object.keys(routing?.questions.route?.criteria ?? {}),
        'openrouter is left out: typesafe reaches the same model directly',
      ).toEqual([
        'typesafe.jev-latest',
        'cloudflare.clef',
        'cloudflare.clef-flash',
        'cloudflare.clef-omni',
      ])
      expect(profile.candidate_calls).toBe(3)
      expect(profile.messages).toBe(11)
      expect(profile.tools).toEqual({ Read: 1, Bash: 1, Grep: 1 })
      expect(
        'conversation' in profile,
        'the routing question sees a profile, not the transcript',
      ).toBe(false)
      expect(deciding?.url).toBe(`${CLOUDFLARE_URL}clef`)
      expect(Object.keys(deciding?.questions ?? {})).toHaveLength(6)
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.lines[0]).toBe(
        'provider decision: cloudflare/clef-flash picked cloudflare/clef, confidence 0.75',
      )
      expect(world.toasts[0]).toContain('cloudflare/clef in 1 request')
    },
  )

  test(
    'success: one usable provider is used without a routing request',
    { options: DECIDING },
    async ($, on) => {
      const world = worldOf(on, {
        env: { TYPESAFE_API_KEY: ENV.TYPESAFE_API_KEY },
        answer: DECIDED,
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(world.requests.map(seen => seen.url)).toEqual([TYPESAFE_URL])
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.lines[0]).toBe(
        'provider decision: one route is available (cloudflare/clef: ' +
          'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; cloudflare/clef-flash: ' +
          'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; ' +
          'cloudflare/clef-omni: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; ' +
          'openrouter/~typesafe/jev-latest: OPENROUTER_API_KEY unset; ' +
          `${ADDED_UNSET}); using the configured typesafe/jev-latest`,
      )
      expect(
        world.settingsReads,
        'the other providers had no key, so the settings were asked for one',
      ).toBe(1)
    },
  )

  test(
    'error: a failed routing request leaves the configured provider to decide',
    { options: DECIDING },
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        answer: DECIDED,
        intercept: seen =>
          'route' in seen.questions
            ? responseOf(401, {
                success: false,
                errors: [{ code: 10000, message: 'Authentication error' }],
              })
            : undefined,
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(world.problems).toEqual([])
      expect(world.requests.map(seen => seen.url)).toEqual([
        `${CLOUDFLARE_URL}clef-flash`,
        TYPESAFE_URL,
      ])
      expect(
        handlesOf(out.messages),
        'the compaction itself still succeeds',
      ).toEqual(DECIDED_HANDLES)
      expect(world.builtIn).toEqual([])
      expect(world.lines[0]).toBe(
        'provider decision: the routing request failed (cloudflare answered ' +
          'HTTP 401: Authentication error); using the configured typesafe/jev-latest',
      )
    },
  )

  test(
    'success: narrowed to the original three providers, the choice and its routing question are what they always were',
    {
      options: {
        ...DECIDING,
        decisionProviders: 'typesafe,cloudflare,openrouter',
      },
    },
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        answer: (id, question, seen) =>
          id === 'route' ? 'typesafe.jev-latest' : DECIDED(id, question, seen),
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })
      const [routing] = world.requests

      expect(world.problems).toEqual([])
      expect(world.requests.map(seen => [seen.url, seen.model])).toEqual([
        [`${CLOUDFLARE_URL}clef-flash`, 'clef-flash'],
        [TYPESAFE_URL, 'jev-latest'],
      ])
      expect(Object.keys(routing?.questions ?? {})).toEqual(['route'])
      expect(Object.keys(routing?.questions.route?.criteria ?? {})).toEqual([
        'typesafe.jev-latest',
        'cloudflare.clef',
        'cloudflare.clef-flash',
        'cloudflare.clef-omni',
      ])
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.lines[0]).toBe(
        'provider decision: cloudflare/clef-flash picked typesafe/jev-latest, confidence 0.75',
      )
    },
  )

  test(
    'success: narrowed to the original three providers, what is ruled out is what it always was',
    {
      options: {
        ...DECIDING,
        decisionProviders: 'typesafe,cloudflare,openrouter',
      },
    },
    async ($, on) => {
      const world = worldOf(on, {
        env: { TYPESAFE_API_KEY: ENV.TYPESAFE_API_KEY },
        answer: DECIDED,
      })

      await $.session.compact({ trigger: 'manual', messages: sessionOf() })

      expect(world.requests.map(seen => seen.url)).toEqual([TYPESAFE_URL])
      expect(world.lines[0]).toBe(
        'provider decision: one route is available (cloudflare/clef: ' +
          'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; cloudflare/clef-flash: ' +
          'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; ' +
          'cloudflare/clef-omni: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; ' +
          'openrouter/~typesafe/jev-latest: OPENROUTER_API_KEY unset); ' +
          'using the configured typesafe/jev-latest',
      )
    },
  )

  test(
    'success: with the decision off only the configured provider is ever asked',
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: DECIDED })

      await $.session.compact({ trigger: 'manual', messages: sessionOf() })

      expect(world.requests.map(seen => seen.url)).toEqual([TYPESAFE_URL])
      expect(
        world.lines.some(line => line.startsWith('provider decision')),
      ).toBe(false)
    },
  )

  test(
    'error: no usable provider falls back naming what is unset',
    { options: DECIDING },
    async ($, on) => {
      const world = worldOf(on, { env: {} })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(out.messages).toEqual([SUMMARY])
      expect(world.requests).toEqual([])
      expect(world.toasts).toEqual([
        'built-in summary used instead: no route can take this job: ' +
          'typesafe/jev-latest: TYPESAFE_API_KEY unset; ' +
          'cloudflare/clef: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; ' +
          'cloudflare/clef-flash: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; ' +
          'cloudflare/clef-omni: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID unset; ' +
          'openrouter/~typesafe/jev-latest: OPENROUTER_API_KEY unset; ' +
          ADDED_UNSET,
      ])
    },
  )

  test(
    'error: a silent routing provider and the compaction after it share one thirty-second bound',
    { options: DECIDING },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, isProviderSilent: true })
      const pending = $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      await world.clock.advance(29_999)

      expect(world.fetches, 'only the routing question is out').toBe(1)
      expect(world.toasts).toEqual([])
      expect(world.builtIn).toEqual([])

      await world.clock.advance(1)

      const out = await pending

      expect(out.messages).toEqual([SUMMARY])
      expect(
        world.fetches,
        'no batch is sent on the configured route after the bound',
      ).toBe(1)
      expect(world.toasts).toEqual([
        'built-in summary used instead: the requests of this compaction ' +
          'were not all answered within 30 seconds',
      ])
      expect(
        world.lines.some(line => line.startsWith('provider decision')),
        'the cut-off routing question decides no route',
      ).toBe(false)
    },
  )
})

describe('session.compact, provider by provider', () => {
  const asked: Record<
    string,
    { provider: string; url: string; model: string; reports: string }
  > = {
    'success: codiv decides a compaction with its own model': {
      provider: 'codiv',
      url: CODIV_URL,
      model: 'openjev-latest',
      reports: 'codiv/openjev-latest in 1 request',
    },
    'success: perplexity decides a compaction with its decider': {
      provider: 'perplexity',
      url: PERPLEXITY_URL,
      model: 'pplx-decider-v1.1-27b',
      reports: 'perplexity/pplx-decider-v1.1-27b in 1 request',
    },
    'success: decisions-api.dev decides a compaction asked by place and its envelope is read':
      {
        provider: 'decisions-api-dev',
        url: DECISIONS_URL,
        model: 'jev-latest',
        reports: 'decisions-api-dev/jev-latest in 1 request',
      },
    'success: decisionapi.net decides a compaction and its envelope is read': {
      provider: 'decisionapi-net',
      url: DECISIONAPI_URL,
      model: 'jev-latest',
      reports: 'decisionapi-net/jev-latest in 1 request',
    },
    'success: openai decides a compaction asked in its own form': {
      provider: 'openai',
      url: OPENAI_URL,
      model: 'gpt-6-luna',
      reports: 'openai/gpt-6-luna in 1 request',
    },
  }

  for (const [name, { provider, url, model, reports }] of Object.entries(
    asked,
  )) {
    test(name, { options: { ...OPTIONS, provider } }, async ($, on) => {
      const world = worldOf(on, { env: ALL_ENV, answer: DECIDED_BY_TEXT })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })
      const [seen] = world.requests

      expect(world.problems).toEqual([])
      expect(
        world.requests.map(request => [request.url, request.model]),
      ).toEqual([[url, model]])
      expect(Object.keys(seen?.questions ?? {})).toEqual(
        provider === 'decisions-api-dev'
          ? ['q0', 'q1', 'q2', 'q3', 'q4', 'q5']
          : [
              'call_t1',
              'result_t1',
              'call_t2',
              'result_t2',
              'call_t3',
              'result_t3',
            ],
      )
      expect(Array.isArray(seen?.body.questions)).toBe(provider === 'openai')
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.builtIn).toEqual([])
      expect(world.toasts).toHaveLength(1)
      expect(world.toasts[0]).toContain(reports)
      expect(world.toasts[0]).toContain('1234 input tokens counted')
      expectNoSecret(world)
    })
  }

  test(
    'error: an envelope reporting failure falls back, naming the provider and its reason without the key',
    { options: { ...OPTIONS, provider: 'decisions-api-dev' } },
    async ($, on) => {
      const world = worldOf(on, {
        env: ALL_ENV,
        intercept: () =>
          responseOf(200, {
            code: 402,
            message: `insufficient credits for ${ADDED_ENV.DECISIONS_API_KEY}`,
          }),
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(out.messages).toEqual([SUMMARY])
      expect(world.toasts).toEqual([
        'built-in summary used instead: decisions-api-dev: the response ' +
          'envelope reports failure: insufficient credits for [redacted]',
      ])
      expectNoSecret(world)
    },
  )

  test(
    'error: an openai answer in a shape it no longer has falls back, naming the field',
    { options: { ...OPTIONS, provider: 'openai' } },
    async ($, on) => {
      const world = worldOf(on, {
        env: ALL_ENV,
        intercept: seen =>
          responseOf(200, {
            model: seen.model,
            answers: [{ kind: 'predicate', name: 'call_t1', probability: 1 }],
          }),
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(out.messages).toEqual([SUMMARY])
      expect(world.toasts).toEqual([
        'built-in summary used instead: openai: answers[0].type is ' +
          'missing, neither predicate nor choice',
      ])
    },
  )

  test(
    'success: every credential variable is read through the engine, each by its own name',
    { options: OPTIONS },
    async ($, on) => {
      const world = worldOf(on, { env: ENV, answer: DECIDED })

      await $.session.compact({ trigger: 'manual', messages: sessionOf() })

      expect([...world.envReads].sort()).toEqual([
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
    },
  )

  test(
    'success: with the decision off and every key set only the configured provider is sent anything',
    { options: { ...OPTIONS, provider: 'openai' } },
    async ($, on) => {
      const world = worldOf(on, {
        env: ALL_ENV,
        answer: DECIDED,
        intercept: () =>
          responseOf(401, {
            error: {
              message:
                `upstream echoed ${ENV.TYPESAFE_API_KEY} and ` +
                ADDED_ENV.OPENAI_API_KEY,
            },
          }),
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(world.requests.map(seen => seen.url)).toEqual([OPENAI_URL])
      expect(out.messages).toEqual([SUMMARY])
      expect(
        world.toasts,
        'a key of a provider not in play is still a secret',
      ).toEqual([
        'built-in summary used instead: openai answered HTTP 401: ' +
          'upstream echoed [redacted] and [redacted]',
      ])
      expectNoSecret(world)
    },
  )

  for (const [provider, url] of [
    ['decisions-api-dev', DECISIONS_URL],
    ['decisionapi-net', DECISIONAPI_URL],
  ] as const) {
    test(
      `success: ${provider} takes about 40 KB of English conversation, the state shrunk to its 32 KiB body`,
      { options: { ...OPTIONS, provider, minReductionRatio: 0 } },
      async ($, on) => {
        const world = worldOf(on, { env: ALL_ENV, answer: DECIDED_BY_TEXT })
        const messages = englishSessionOf(20, 2000)
        const sent = messages.reduce(
          (chars, message) => chars + message.text.length,
          0,
        )
        const out = await $.session.compact({ trigger: 'manual', messages })

        expect(sent > 40_000, `${sent} characters of text`).toBe(true)
        expect(world.problems).toEqual([])
        expect(world.requests.map(seen => seen.url)).toEqual([url])
        expect(handlesOf(out.messages)).toEqual([
          'h0',
          ...Array.from({ length: 20 }, (_, at) => `p${at + 1}`),
          ...DECIDED_HANDLES.slice(1),
        ])
        expect(world.builtIn).toEqual([])
        expect(world.toasts).toHaveLength(1)
        expect(
          world.toasts[0]?.includes('(whole)'),
          `the state was reduced: ${world.toasts[0]}`,
        ).toBe(false)
      },
    )
  }

  test(
    'success: decisions-api.dev asks about more calls than eight questions hold in several requests, each named from q0',
    { options: { provider: 'decisions-api-dev', preserveRecentMessages: 0 } },
    async ($, on) => {
      // Odd calls are kept whole and even ones dropped, read off the text of
      // the question, since its id names only its place in the request.
      const world = worldOf(on, {
        env: ALL_ENV,
        answer: (_id, question) =>
          Number(/tool call t(\d+) /.exec(question.instructions)?.[1]) % 2 ===
          1
            ? 0.9
            : 0.1,
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: readsOf(6),
      })

      expect(world.problems).toEqual([])
      expect(
        world.requests.map(seen => Object.keys(seen.questions)),
      ).toEqual([
        ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'],
        ['q0', 'q1', 'q2', 'q3'],
      ])
      expect(
        world.requests.map(seen =>
          Object.values(seen.questions).map(
            question => /tool call (t\d+) /.exec(question.instructions)?.[1],
          ),
        ),
      ).toEqual([
        ['t1', 't1', 't2', 't2', 't3', 't3', 't4', 't4'],
        ['t5', 't5', 't6', 't6'],
      ])
      expect(handlesOf(out.messages)).toEqual([
        'first',
        'call1',
        'result1',
        'call3',
        'result3',
        'call5',
        'result5',
        'last',
      ])
      expect(world.builtIn).toEqual([])
      expect(world.toasts[0]).toContain('in 2 requests')
    },
  )
})

describe('provider decision over every provider', () => {
  const DECIDING = { ...OPTIONS, providerDecision: true }

  test(
    'success: by default every provider with a key is offered once per model and the routing question goes to clef-flash',
    { options: DECIDING },
    async ($, on) => {
      const world = worldOf(on, {
        env: ALL_ENV,
        answer: (id, question, seen) =>
          id === 'route' ? 'openai.gpt-6-luna' : DECIDED(id, question, seen),
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })
      const [routing, deciding] = world.requests

      expect(world.problems).toEqual([])
      expect(world.requests.map(seen => seen.url)).toEqual([
        `${CLOUDFLARE_URL}clef-flash`,
        OPENAI_URL,
      ])
      expect(
        Object.keys(routing?.questions.route?.criteria ?? {}),
        'the three gateways to jev are left out for typesafe',
      ).toEqual([
        'typesafe.jev-latest',
        'cloudflare.clef',
        'cloudflare.clef-flash',
        'cloudflare.clef-omni',
        'codiv.openjev-latest',
        'perplexity.pplx-decider-v1.1-27b',
        'openai.gpt-6-luna',
      ])
      expect(Object.keys(deciding?.questions ?? {})).toHaveLength(6)
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.lines[0]).toBe(
        'provider decision: cloudflare/clef-flash picked openai/gpt-6-luna, confidence 0.75',
      )
      expect(world.toasts[0]).toContain('openai/gpt-6-luna in 1 request')
      expectNoSecret(world)
    },
  )

  test(
    'success: cloudflare left out of decisionProviders is never sent the routing question',
    { options: { ...DECIDING, decisionProviders: 'typesafe,openai' } },
    async ($, on) => {
      const world = worldOf(on, {
        env: ALL_ENV,
        answer: (id, question, seen) =>
          id === 'route' ? 'typesafe.jev-latest' : DECIDED(id, question, seen),
      })

      await $.session.compact({ trigger: 'manual', messages: sessionOf() })

      const [routing] = world.requests

      expect(world.problems).toEqual([])
      expect(world.requests.map(seen => seen.url)).toEqual([
        TYPESAFE_URL,
        TYPESAFE_URL,
      ])
      expect(Object.keys(routing?.questions ?? {})).toEqual(['route'])
      expect(Object.keys(routing?.questions.route?.criteria ?? {})).toEqual([
        'typesafe.jev-latest',
        'openai.gpt-6-luna',
      ])
      expect(world.lines[0]).toBe(
        'provider decision: typesafe/jev-latest picked typesafe/jev-latest, confidence 0.75',
      )
    },
  )

  test(
    'success: with openai configured and no cloudflare key the routing question goes to openai in its own form',
    {
      options: {
        ...DECIDING,
        provider: 'openai',
        decisionProviders: 'typesafe',
      },
    },
    async ($, on) => {
      const world = worldOf(on, {
        env: {
          TYPESAFE_API_KEY: ENV.TYPESAFE_API_KEY,
          OPENAI_API_KEY: ADDED_ENV.OPENAI_API_KEY,
        },
        answer: (id, question, seen) =>
          id === 'route' ? 'typesafe.jev-latest' : DECIDED(id, question, seen),
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })
      const [routing] = world.requests

      expect(world.problems).toEqual([])
      expect(world.requests.map(seen => seen.url)).toEqual([
        OPENAI_URL,
        TYPESAFE_URL,
      ])
      expect(routing?.body.questions).toEqual([
        {
          name: 'route',
          type: 'choice',
          instructions: expect.stringContaining('Which decision model'),
          choices: [
            {
              value: 'typesafe.jev-latest',
              description: expect.stringContaining("TypeSafe's flagship"),
            },
            {
              value: 'openai.gpt-6-luna',
              description:
                'GPT-6 Luna, which OpenAI describes as its most efficient ' +
                'model for focused, high-volume tasks, served through its ' +
                'Decisions API.',
            },
          ],
        },
      ])
      expect(typeof routing?.body.input).toBe('string')
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.lines[0]).toBe(
        'provider decision: openai/gpt-6-luna picked typesafe/jev-latest, confidence 0.75',
      )
    },
  )

  test(
    'success: of three gateways to jev the first is offered and the line says which it stands for',
    {
      options: {
        ...DECIDING,
        provider: 'openrouter',
        decisionProviders: 'openrouter,decisions-api-dev,decisionapi-net',
      },
    },
    async ($, on) => {
      const world = worldOf(on, {
        env: {
          OPENROUTER_API_KEY: ENV.OPENROUTER_API_KEY,
          DECISIONS_API_KEY: ADDED_ENV.DECISIONS_API_KEY,
          DECISIONAPI_API_KEY: ADDED_ENV.DECISIONAPI_API_KEY,
        },
        answer: DECIDED,
      })

      await $.session.compact({ trigger: 'manual', messages: sessionOf() })

      expect(world.requests.map(seen => seen.url)).toEqual([OPENROUTER_URL])
      expect(world.lines[0]).toBe(
        'provider decision: one route is available (decisions-api-dev/' +
          'jev-latest: the same model as openrouter/~typesafe/jev-latest; ' +
          'decisionapi-net/jev-latest: the same model as ' +
          'openrouter/~typesafe/jev-latest); using the configured ' +
          'openrouter/~typesafe/jev-latest',
      )
    },
  )

  test(
    'success: a reseller whose 32 KiB the state would overrun is not offered, though its tokens fit',
    {
      options: {
        ...DECIDING,
        decisionProviders: 'decisionapi-net',
      },
    },
    async ($, on) => {
      const world = worldOf(on, {
        env: {
          TYPESAFE_API_KEY: ENV.TYPESAFE_API_KEY,
          DECISIONAPI_API_KEY: ADDED_ENV.DECISIONAPI_API_KEY,
        },
        answer: DECIDED,
      })
      const messages = sessionOf()

      // One unbroken run of letters: six to a token as estimated, one byte
      // each, so the state stays inside the reseller's token figure and
      // still takes more than 32 KiB.
      messages[7] = calling('a'.repeat(33_000), [], 'h7')

      await $.session.compact({ trigger: 'manual', messages })

      expect(world.problems).toEqual([])
      expect(world.requests.map(seen => seen.url)).toEqual([TYPESAFE_URL])
      expect(world.lines[0]).toMatch(
        /^provider decision: one route is available \(decisionapi-net\/jev-latest: no question fits beside the state: the request takes 3\d{4} of the 27852 bytes it may hold before any question\); using the configured typesafe\/jev-latest$/,
      )
    },
  )

  test(
    'success: a CJK-heavy state over 32 KiB rules out both resellers and is decided by typesafe',
    {
      options: {
        ...DECIDING,
        decisionProviders: 'decisions-api-dev,decisionapi-net',
      },
    },
    async ($, on) => {
      const world = worldOf(on, {
        env: {
          TYPESAFE_API_KEY: ENV.TYPESAFE_API_KEY,
          DECISIONS_API_KEY: ADDED_ENV.DECISIONS_API_KEY,
          DECISIONAPI_API_KEY: ADDED_ENV.DECISIONAPI_API_KEY,
        },
        answer: DECIDED,
      })
      const messages = sessionOf()

      // Twelve thousand characters of Japanese: about as many tokens, well
      // inside what typesafe takes, and three UTF-8 bytes each.
      messages[7] = calling('日本語の文章'.repeat(2000), [], 'h7')

      const out = await $.session.compact({ trigger: 'manual', messages })
      const [seen] = world.requests

      expect(world.problems).toEqual([])
      expect(world.requests.map(request => request.url)).toEqual([
        TYPESAFE_URL,
      ])
      expect(
        new TextEncoder().encode(JSON.stringify(seen?.state)).length > 32_768,
        'typesafe was sent more than the resellers could take',
      ).toBe(true)
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.lines[0]).toMatch(
        /^provider decision: one route is available \(decisions-api-dev\/jev-latest: .+; decisionapi-net\/jev-latest: .+\); using the configured typesafe\/jev-latest$/,
      )
    },
  )

  test(
    'error: an unknown name in decisionProviders is dropped, said once without a secret, and the compaction goes on',
    {
      options: {
        ...DECIDING,
        decisionProviders: `typesafe, nope ,${ENV.TYPESAFE_API_KEY}`,
      },
    },
    async ($, on) => {
      const world = worldOf(on, {
        env: { TYPESAFE_API_KEY: ENV.TYPESAFE_API_KEY },
        answer: DECIDED,
      })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })
      const said = world.lines.filter(line =>
        line.includes('decisionProviders'),
      )

      expect(said).toEqual([
        'the decisionProviders option names "nope", "[redacted]", which ' +
          'are none of typesafe, cloudflare, openrouter, codiv, perplexity, ' +
          'decisions-api-dev, decisionapi-net, openai; ignored',
      ])
      expect(world.requests.map(seen => seen.url)).toEqual([TYPESAFE_URL])
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expectNoSecret(world)
    },
  )

  test(
    'error: a very long unknown name in decisionProviders is quoted only in part',
    {
      options: {
        ...DECIDING,
        decisionProviders: `typesafe,${'x'.repeat(200)}`,
      },
    },
    async ($, on) => {
      const world = worldOf(on, {
        env: { TYPESAFE_API_KEY: ENV.TYPESAFE_API_KEY },
        answer: DECIDED,
      })

      await $.session.compact({ trigger: 'manual', messages: sessionOf() })

      expect(
        world.lines.filter(line => line.includes('decisionProviders')),
        'the opening quote and 159 characters of the name, then an ellipsis',
      ).toEqual([
        `the decisionProviders option names "${'x'.repeat(159)}…, which ` +
          'is none of typesafe, cloudflare, openrouter, codiv, perplexity, ' +
          'decisions-api-dev, decisionapi-net, openai; ignored',
      ])
    },
  )

  test(
    'success: a cleared decisionProviders leaves only the configured provider, every key set',
    { options: { ...DECIDING, provider: 'codiv', decisionProviders: '' } },
    async ($, on) => {
      const world = worldOf(on, { env: ALL_ENV, answer: DECIDED })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(world.problems).toEqual([])
      expect(world.requests.map(seen => seen.url)).toEqual([CODIV_URL])
      expect(handlesOf(out.messages)).toEqual(DECIDED_HANDLES)
      expect(world.lines).toContain(
        'provider decision: one route is available; using the configured ' +
          'codiv/openjev-latest',
      )
    },
  )

  test(
    'error: a cloudflare model outside its catalogue is refused before routing, and nothing is sent',
    {
      options: { ...DECIDING, provider: 'cloudflare', model: 'llama-3-8b' },
    },
    async ($, on) => {
      const world = worldOf(on, { env: ALL_ENV, answer: DECIDED })
      const out = await $.session.compact({
        trigger: 'manual',
        messages: sessionOf(),
      })

      expect(world.fetches).toBe(0)
      expect(out.messages).toEqual([SUMMARY])
      expect(world.toasts).toEqual([
        'built-in summary used instead: cloudflare serves clef, ' +
          'clef-flash and clef-omni, not "llama-3-8b"',
      ])
    },
  )

  test(
    'success: a cloudflare model named by its catalogue id is offered with the other cloudflare model',
    {
      options: {
        ...DECIDING,
        provider: 'cloudflare',
        model: '@cf/cloudflare/clef',
        decisionProviders: 'cloudflare',
      },
    },
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        answer: (id, question, seen) =>
          id === 'route' ? 'cloudflare.clef' : DECIDED(id, question, seen),
      })

      await $.session.compact({ trigger: 'manual', messages: sessionOf() })

      const [routing] = world.requests

      expect(world.problems).toEqual([])
      expect(Object.keys(routing?.questions.route?.criteria ?? {})).toEqual([
        'cloudflare.clef',
        'cloudflare.clef-flash',
        'cloudflare.clef-omni',
      ])
      expect(world.requests.map(seen => seen.url)).toEqual([
        `${CLOUDFLARE_URL}clef-flash`,
        `${CLOUDFLARE_URL}clef`,
      ])
    },
  )
})

describe('turn.complete', () => {
  const TURN = {
    turnId: 't',
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    reason: 'answer',
  } as const
  const WITH_ENGINE = { plugins: [ENGINE_MESSAGES] }

  const single: Record<
    string,
    {
      options?: Record<string, number>
      percents: (number | undefined)[]
      agentId?: string
      isAborted?: boolean
      compactions: number
    }
  > = {
    'success: a turn the person interrupted requests nothing': {
      percents: [99],
      isAborted: true,
      compactions: 0,
    },
    'success: usage under the threshold requests nothing': {
      percents: [59],
      compactions: 0,
    },
    'success: usage at the threshold requests a compaction': {
      percents: [60, 20],
      compactions: 1,
    },
    'success: unknown usage requests nothing': {
      percents: [undefined],
      compactions: 0,
    },
    'success: a threshold of 0 turns the trigger off': {
      options: { compactAtPercent: 0 },
      percents: [99],
      compactions: 0,
    },
    'success: a raised threshold is honoured below it': {
      options: { compactAtPercent: 80 },
      percents: [79],
      compactions: 0,
    },
    'success: a raised threshold is honoured at it': {
      options: { compactAtPercent: 80 },
      percents: [80, 20],
      compactions: 1,
    },
    "success: a subagent's turn requests nothing": {
      percents: [99],
      agentId: 'agent-7',
      compactions: 0,
    },
  }

  for (const [
    name,
    { options, percents, agentId, isAborted, compactions },
  ] of Object.entries(single)) {
    test(name, { ...WITH_ENGINE, options: { ...options } }, async ($, on) => {
      const world = worldOf(on, { env: ENV, percents })
      const out = await $.turn.complete({
        ...TURN,
        ...(agentId === undefined ? {} : { agentId }),
        ...(isAborted === true
          ? { isAborted: true, reason: 'aborted' as const }
          : {}),
      })

      expect(out).toEqual({ text: '' })
      expect(world.builtIn).toHaveLength(compactions)
    })
  }

  const rearmed: Record<
    string,
    {
      options?: Record<string, number>
      percents: (number | undefined)[]
      counts: number[]
    }
  > = {
    'success: after a compaction that got under the threshold the next crossing asks at once':
      {
        // 75 asks and the compaction leaves 55; 61 is a new crossing.
        percents: [75, 55, 61, 20],
        counts: [1, 2],
      },
    'success: a threshold of 95 asks again after a compaction that left 92': {
      options: { compactAtPercent: 95 },
      percents: [95, 92, 96, 40],
      counts: [1, 2],
    },
    'success: a compaction that left usage at the threshold makes the next wait':
      {
        percents: [75, 60, 69, 70, 20],
        counts: [1, 1, 2],
      },
  }

  for (const [name, { options, percents, counts }] of Object.entries(rearmed)) {
    test(name, { ...WITH_ENGINE, options: { ...options } }, async ($, on) => {
      const world = worldOf(on, { env: ENV, percents })
      const seen: number[] = []

      for (const _count of counts) {
        await $.turn.complete(TURN)
        seen.push(world.builtIn.length)
      }

      expect(seen).toEqual(counts)
    })
  }

  test(
    'error: the reason a compaction was not run is logged without a bearer token',
    WITH_ENGINE,
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        usageFails: 'the usage is closed; the caller sent Bearer abc123',
      })

      expect(await $.turn.complete(TURN), 'the turn still completes').toEqual({
        text: '',
      })
      expect(world.builtIn).toEqual([])
      expect(world.lines).toHaveLength(1)
      expect(world.lines[0]).toMatch(
        /^compaction at 60% of the context was not run: .*the usage is closed; the caller sent \[redacted\]$/,
      )
      expectNoSecret(world)
    },
  )

  test(
    "success: the requested compaction goes through this plugin's own hook",
    WITH_ENGINE,
    async ($, on) => {
      const world = worldOf(on, { env: ENV, percents: [75, 20] })

      await $.turn.complete(TURN)

      expect(
        world.toasts,
        'the hook judged the transcript and found nothing to remove',
      ).toEqual([
        'built-in summary used instead: the reduction is below the 25% minimum (0% smaller; no answered tool call)',
      ])
      expect(handlesOf(world.builtIn[0]?.messages)).toEqual(['h0', 'h1'])
    },
  )

  test(
    'success: after a compaction that left usage high the next waits for ten more points',
    WITH_ENGINE,
    async ($, on) => {
      // In order: the reading at each turn's end and, after a compaction, the
      // reading that follows it.
      const world = worldOf(on, {
        env: ENV,
        percents: [75, 70, 75, 79, 80, 30, 40, 60, 10],
      })
      const counts: number[] = []

      for (let turn = 0; turn < 6; turn++) {
        await $.turn.complete(TURN)
        counts.push(world.builtIn.length)
      }

      expect(
        counts,
        '75 asks, 75 and 79 wait, 80 asks, 40 forgets, 60 asks',
      ).toEqual([1, 1, 1, 2, 2, 3])
    },
  )

  test(
    'success: usage unknown after a compaction takes the next reading as the floor',
    WITH_ENGINE,
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        percents: [75, undefined, 72, 81, 82, undefined],
      })
      const counts: number[] = []

      for (let turn = 0; turn < 4; turn++) {
        await $.turn.complete(TURN)
        counts.push(world.builtIn.length)
      }

      expect(
        counts,
        '75 asks, 72 becomes the floor, 81 waits, 82 asks',
      ).toEqual([1, 1, 1, 2])
    },
  )

  test(
    'error: a compaction the engine refuses is logged and not asked for again next turn',
    WITH_ENGINE,
    async ($, on) => {
      const world = worldOf(on, {
        env: ENV,
        percents: [75, 76, 85],
        builtInFails: true,
      })
      const counts: number[] = []

      for (let turn = 0; turn < 3; turn++) {
        expect(await $.turn.complete(TURN), 'the turn still completes').toEqual(
          { text: '' },
        )
        counts.push(world.builtIn.length)
      }

      expect(counts, '75 asks and fails, 76 waits, 85 asks again').toEqual([
        1, 1, 2,
      ])
      expect(
        world.lines.filter(line =>
          line.startsWith('compaction at 60% of the context was not run: '),
        ),
      ).toHaveLength(2)
    },
  )

  test(
    'success: a turn ending while a compaction runs requests no second one',
    WITH_ENGINE,
    async ($, on) => {
      // Without the guard the second turn would read 90, which is past the
      // floor of 75 by more than ten points, and request another compaction.
      const world = worldOf(on, {
        env: ENV,
        percents: [75, 90, 20],
        builtInDelayMs: 1000,
      })
      const first = $.turn.complete(TURN)

      await world.clock.settle()

      expect(world.builtIn, 'the first compaction is under way').toHaveLength(1)

      await $.turn.complete(TURN)

      expect(world.builtIn).toHaveLength(1)

      await world.clock.advance(1000)
      await first

      expect(world.builtIn).toHaveLength(1)
    },
  )
})
