import type {
  Args,
  HookFor,
  HttpResponse,
  On,
  Pattern,
  SessionCompactInput,
  SessionMessage,
} from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock, Plugin } from 'claude-code/testing'

import type { Call } from '../hooks/state'

/**
 * Obvious fakes: nothing here is, or looks like, a real credential.
 */
export const ENV = {
  TYPESAFE_API_KEY: 'test-typesafe-key',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  CLOUDFLARE_API_TOKEN: 'test-cloudflare-token',
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
} as const

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/systemone'
export const CLOUDFLARE_URL =
  'https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/cloudflare/'

/**
 * What the stub standing for the engine's own compaction answers with.
 */
export const SUMMARY: SessionMessage = {
  role: 'user',
  text: 'BUILT-IN SUMMARY',
  toolUses: [],
}

/**
 * One question as a request body carries it.
 */
export type AskedQuestion = {
  type: string
  instructions: string
  criteria?: Record<string, unknown>
}

/**
 * One request the fake provider received, decoded.
 */
export type Seen = {
  url: string
  provider: 'typesafe' | 'openrouter' | 'cloudflare'
  model: string
  state: unknown
  questions: Record<string, AskedQuestion>
}

/**
 * Answers one question: a probability for a `noul`, an option name for a
 * `choice`.
 */
export type Answerer = (
  id: string,
  question: AskedQuestion,
  seen: Seen,
) => number | string

export type Setup = {
  env?: Readonly<Record<string, string>>
  /**
   * Makes every read of the environment fail with this reason.
   */
  envFails?: string
  settingsEnv?: Readonly<Record<string, string>>
  /**
   * Makes reading the settings fail with this reason.
   */
  settingsFails?: string
  answer?: Answerer
  /**
   * Makes the host reject every request with this reason, before it reaches
   * the fake provider.
   */
  fetchFails?: string
  /**
   * Makes the fake provider accept every request and never answer it.
   */
  isProviderSilent?: boolean
  /**
   * Replaces the fake provider's response to a request it found valid; the
   * count starts at 1. Answering undefined lets the normal response through.
   */
  intercept?: (seen: Seen, count: number) => HttpResponse | undefined
  /**
   * What `$.session.usage()` reads as `context.percent`, one per call; the
   * last value repeats.
   */
  percents?: readonly (number | undefined)[]
  /**
   * Makes reading the usage fail with this reason.
   */
  usageFails?: string
  /**
   * Makes the engine's own compaction fail, as a compaction requested while
   * it cannot run does.
   */
  builtInFails?: boolean
  /**
   * Makes the engine's own compaction take this long on the mock clock.
   */
  builtInDelayMs?: number
}

export type World = {
  requests: Seen[]
  /**
   * Everything the fake provider found wrong with a request. A test of a
   * working path asserts this is empty.
   */
  problems: string[]
  toasts: string[]
  lines: string[]
  /**
   * The compactions that reached the engine's own, beneath the plugin.
   */
  builtIn: SessionCompactInput[]
  /**
   * How many times the settings were read.
   */
  settingsReads: number
  /**
   * How many requests were handed to the host, answered or not.
   */
  fetches: number
  /**
   * Every `$.clock.sleep` the plugin started, in order.
   */
  waits: Wait[]
  clock: MockClock
}

/**
 * One `$.clock.sleep` as the clock saw it: how long it was for, and whether
 * it ran to its end. A wait whose dispatch is aborted is dropped by the
 * clock and never ends.
 */
export type Wait = { ms: number; hasEnded: boolean }

/**
 * The test's `on` as `mock.clock` is handed it: the same registrar, but the
 * clock's `clock.sleep` hook is wrapped so that every wait it holds is
 * recorded in `waits`.
 */
function recordingWaits(on: On, waits: Wait[]): On {
  const register = on as (pattern: Pattern, hook: unknown) => unknown

  return ((pattern: Pattern, hook: HookFor<'clock.sleep'>) => {
    if (pattern !== 'clock.sleep') {
      return register(pattern, hook)
    }

    return on('clock.sleep', async ($, e, next) => {
      const wait: Wait = { ms: e.ms, hasEnded: false }

      waits.push(wait)

      const answer = await hook($, e, next)

      wait.hasEnded = true

      return answer
    })
  }) as On
}

const QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/

function jsonResponse(status: number, payload: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify(payload),
  }
}

/**
 * A response with a JSON body, for a test's `intercept`.
 */
export function responseOf(status: number, payload: unknown): HttpResponse {
  return jsonResponse(status, payload)
}

/**
 * Checks a request the way the real endpoints would and decodes it, or says
 * what is wrong with it.
 */
function decode(e: Args<'http.fetch'>): Seen | string {
  const headers = e.init?.headers ?? {}
  let provider: Seen['provider']
  let bearer: string
  let urlModel: string | undefined

  if (e.url === TYPESAFE_URL) {
    provider = 'typesafe'
    bearer = ENV.TYPESAFE_API_KEY
  } else if (e.url === OPENROUTER_URL) {
    provider = 'openrouter'
    bearer = ENV.OPENROUTER_API_KEY
  } else if (e.url.startsWith(CLOUDFLARE_URL)) {
    provider = 'cloudflare'
    bearer = ENV.CLOUDFLARE_API_TOKEN
    urlModel = e.url.slice(CLOUDFLARE_URL.length)
  } else {
    return `unknown URL ${e.url}`
  }

  if (e.init?.method !== 'POST') {
    return `method is ${String(e.init?.method)}, not POST`
  }

  if (headers.authorization !== `Bearer ${bearer}`) {
    return `${provider}: the authorization header is not the expected bearer`
  }

  if (headers['content-type'] !== 'application/json') {
    return `${provider}: content-type is ${String(headers['content-type'])}`
  }

  let body: { model?: unknown; state?: unknown; questions?: unknown }

  try {
    body = JSON.parse(e.init.body ?? '')
  } catch {
    return `${provider}: the body is not JSON`
  }

  if (typeof body.model !== 'string' || body.model === '') {
    return `${provider}: no model`
  }

  if (body.state === undefined) {
    return `${provider}: no state`
  }

  if (typeof body.questions !== 'object' || body.questions === null) {
    return `${provider}: no questions`
  }

  const questions = body.questions as Record<string, AskedQuestion>
  const ids = Object.keys(questions)

  if (ids.length === 0) {
    return `${provider}: an empty questions map`
  }

  if (provider === 'cloudflare') {
    if (urlModel !== 'clef' && urlModel !== 'clef-flash') {
      return `cloudflare: the URL names the model ${String(urlModel)}`
    }

    if (body.model !== urlModel) {
      return `cloudflare: body model ${body.model} under URL model ${urlModel}`
    }

    if (ids.length > 64) {
      return `cloudflare: ${ids.length} questions, more than 64`
    }
  }

  const badId = ids.find(id => !QUESTION_ID.test(id))

  if (badId !== undefined) {
    return `${provider}: question id ${badId} is not valid`
  }

  return {
    url: e.url,
    provider,
    model: body.model,
    state: body.state,
    questions,
  }
}

/**
 * The response the provider would send: the answers under the same ids, in
 * that provider's envelope.
 */
function answerOf(seen: Seen, answer: Answerer): HttpResponse {
  const answers: Record<string, unknown> = {}

  for (const [id, question] of Object.entries(seen.questions)) {
    const said = answer(id, question, seen)

    answers[id] =
      question.type === 'choice'
        ? {
            type: 'choice',
            choice: said,
            probabilities: { [String(said)]: 1 },
            confidence: 0.75,
          }
        : { type: 'noul', noul: said }
  }

  const usage = { input_tokens: 1234, output_tokens: 20 }

  if (seen.provider === 'cloudflare') {
    return jsonResponse(200, {
      result: { model: seen.model, answers, usage },
      success: true,
      errors: [],
      messages: [],
    })
  }

  if (seen.provider === 'openrouter') {
    return jsonResponse(200, {
      id: 'gen-dec-test',
      model: 'typesafe/jev-1.13',
      provider: 'TypeSafe',
      answers,
      usage: { ...usage, cost: 0.00005 },
    })
  }

  return jsonResponse(200, { model: 'jev-1.13.0', answers, usage })
}

/**
 * Stands the engine up beneath the plugin: the environment, the settings,
 * the clock, the log and toast sinks, the usage reading, the engine's own
 * compaction, and a fake System One provider at `http.fetch`. Nothing here
 * reaches a network.
 *
 * @param on the test's registrar
 * @param setup what this test's world holds
 * @returns what the plugin did to the world
 */
export function worldOf(on: On, setup: Setup = {}): World {
  const waits: Wait[] = []
  const world: World = {
    requests: [],
    problems: [],
    toasts: [],
    lines: [],
    builtIn: [],
    settingsReads: 0,
    fetches: 0,
    waits,
    clock: mock.clock(recordingWaits(on, waits)),
  }
  const answer = setup.answer ?? (() => 0.9)
  let usageReads = 0

  if (setup.envFails === undefined) {
    mock.env(on, setup.env ?? {})
  } else {
    const reason = setup.envFails

    on('env.get', () => ({ deny: reason }))
  }

  on('settings.read', () => {
    world.settingsReads++

    return setup.settingsFails === undefined
      ? { value: { env: setup.settingsEnv ?? {} } }
      : { deny: setup.settingsFails }
  })

  on('ui.log', ($, e) => {
    world.lines.push(e.text)

    return { value: undefined }
  })

  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })

  on('session.usage', () => {
    if (setup.usageFails !== undefined) {
      return { deny: setup.usageFails }
    }

    const percents = setup.percents ?? []
    const percent = percents[Math.min(usageReads, percents.length - 1)]

    usageReads++

    return {
      value: {
        startedAt: 0,
        context:
          percent === undefined
            ? { window: 200_000 }
            : { window: 200_000, percent },
        rateLimits: [],
      },
    }
  })

  on('http.fetch', ($, e) => {
    world.fetches++

    if (setup.fetchFails !== undefined) {
      return { deny: setup.fetchFails }
    }

    if (setup.isProviderSilent === true) {
      return new Promise<never>(() => {})
    }

    const seen = decode(e)

    if (typeof seen === 'string') {
      world.problems.push(seen)

      return { value: jsonResponse(422, { error: { message: seen } }) }
    }

    world.requests.push(seen)

    return {
      value:
        setup.intercept?.(seen, world.requests.length) ??
        answerOf(seen, answer),
    }
  })

  on('session.compact', async ($, e) => {
    world.builtIn.push(e)

    if (setup.builtInFails === true) {
      throw new Error('the engine cannot compact now')
    }

    if (setup.builtInDelayMs !== undefined) {
      await world.clock.sleep(setup.builtInDelayMs)
    }

    return { messages: [SUMMARY] }
  })

  on('turn.complete', () => ({ text: '' }))

  return world
}

/**
 * The `abort` listeners put on a signal, tracked by identity: `added` counts
 * every one put on, `live` holds those not taken off again since. Only an
 * explicit removal takes a listener out of `live`, so one added with `once`
 * that has since fired is still there.
 *
 * @param signal a real signal, whose own methods go on doing the work
 * @returns the count and the set, kept up to date as the signal is used
 */
export function listenersOf(signal: AbortSignal): {
  added: () => number
  live: Set<() => void>
} {
  const live = new Set<() => void>()
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  let added = 0

  signal.addEventListener = (type, listener, options) => {
    added++
    live.add(listener)
    add(type, listener, options)
  }
  signal.removeEventListener = (type, listener) => {
    live.delete(listener)
    remove(type, listener)
  }

  return { added: () => added, live }
}

/**
 * Does what the engine does for a compaction a plugin requests: supplies
 * the transcript. The kit passes a plugin's `$.session.compact()` on with no
 * messages, which no hook in a session ever sees.
 *
 * Self-contained, as an inline plugin has to be: it closes over nothing.
 */
export const ENGINE_MESSAGES: Plugin = {
  name: 'engine-messages',
  tier: 'prepend',
  register(on) {
    on('session.compact', ($, e, next) =>
      next(
        Array.isArray(e.messages)
          ? e
          : {
              ...e,
              messages: [
                { role: 'user', text: 'hello', toolUses: [], handle: 'h0' },
                { role: 'assistant', text: 'hi', toolUses: [], handle: 'h1' },
              ],
            },
      ),
    )
  },
}

/**
 * A message the person typed.
 */
export function said(text: string, handle?: string): SessionMessage {
  return handle === undefined
    ? { role: 'user', text, toolUses: [] }
    : { role: 'user', text, toolUses: [], handle }
}

/**
 * An assistant message making the given calls: `[tool_use_id, tool, input]`.
 */
export function calling(
  text: string,
  uses: readonly (readonly [string, string, Record<string, unknown>])[],
  handle?: string,
): SessionMessage {
  const message: SessionMessage = {
    role: 'assistant',
    text,
    toolUses: uses.map(([id, tool, input]) => ({
      tool_use_id: id,
      tool,
      input,
    })),
  }

  if (handle !== undefined) {
    message.handle = handle
  }

  return message
}

/**
 * A user message answering calls: `[tool_use_id, text, isError?]`.
 */
export function answering(
  results: readonly (readonly [string, string, boolean?])[],
  handle?: string,
): SessionMessage {
  const message: SessionMessage = {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: results.map(([id, text, isError]) => ({
      tool_use_id: id,
      text,
      isError: isError === true,
    })),
  }

  if (handle !== undefined) {
    message.handle = handle
  }

  return message
}

/**
 * Copies every result onto the tool use it answers, as a transcript has it
 * once the call is answered.
 */
export function withOutcomes(messages: SessionMessage[]): SessionMessage[] {
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      for (const other of messages) {
        for (const use of other.toolUses) {
          if (use.tool_use_id === result.tool_use_id) {
            use.text = result.text

            if (result.isError) {
              use.isError = true
            }
          }
        }
      }
    }
  }

  return messages
}

/**
 * A session of eleven messages with four answered calls. With the newest
 * two messages pinned, `t1` (Read), `t2` (Bash, an error) and `t3` (Grep)
 * are candidates and `t4` (Edit) is pinned.
 */
export function sessionOf(): SessionMessage[] {
  return withOutcomes([
    said('Fix the failing test in src/a.ts', 'h0'),
    calling(
      'Reading the file.',
      [['u1', 'Read', { file_path: 'src/a.ts' }]],
      'h1',
    ),
    answering([['u1', 'r'.repeat(5000)]], 'h2'),
    calling('', [['u2', 'Bash', { command: 'npm test' }]], 'h3'),
    answering([['u2', 'e'.repeat(4000), true]], 'h4'),
    calling('Searching.', [['u3', 'Grep', { pattern: 'expect' }]], 'h5'),
    answering([['u3', 'g'.repeat(3000)]], 'h6'),
    calling('Exploration is done.', [], 'h7'),
    said('Now fix it', 'h8'),
    calling('Fixing.', [['u4', 'Edit', { file_path: 'src/a.ts' }]], 'h9'),
    answering([['u4', 'ok']], 'h10'),
  ])
}

/**
 * A session of `count` answered Read calls between a first and a last
 * prompt, every result 600 characters long.
 */
export function readsOf(count: number): SessionMessage[] {
  const messages = [said('Read everything', 'first')]

  for (let n = 1; n <= count; n++) {
    messages.push(
      calling(
        '',
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
 * Answers by call: `{ t1: [keepCall, keepResult] }`; a call not listed gets
 * 0.9 for both, so it is kept.
 */
export function scoring(
  scores: Readonly<Record<string, readonly [number, number]>>,
): Answerer {
  return id => {
    const [kind, call] = id.split('_')
    const pair = scores[call ?? '']

    if (pair === undefined) {
      return 0.9
    }

    return kind === 'call' ? pair[0] : pair[1]
  }
}

/**
 * A paired call for a test that needs calls without a transcript.
 */
export function callOf(n: number, over: Partial<Call> = {}): Call {
  return {
    id: `t${n}`,
    toolUseId: `u${n}`,
    tool: 'Read',
    input: { file_path: `src/file${n}.ts` },
    callIndex: n * 2 - 1,
    resultIndex: n * 2,
    resultChars: 1000,
    isError: false,
    isPinned: false,
    ...over,
  }
}
