import type { HttpInit, HttpResponse } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  askerOf,
  attemptOf,
  BACKOFF_MS,
  COMPACTION_DEADLINE_MS,
} from '../hooks/ask'
import { routeOf } from '../hooks/providers'
import type { Credentials, Route } from '../hooks/providers'
import { listenersOf } from './fixtures'

const CREDENTIALS = { typesafeApiKey: 'test-typesafe-key' }
const QUESTIONS = { call_t1: { type: 'noul', instructions: 'Is it?' } } as const
const OK = {
  model: 'jev-1.13.0',
  answers: { call_t1: { type: 'noul', noul: 0.7 } },
  usage: {},
}
const DEADLINE_MESSAGE =
  'the requests of this compaction were not all answered within 30 seconds'
const INTERRUPTED_MESSAGE =
  'the compaction was interrupted before its requests were answered'
const CLOSED_MESSAGE = 'the compaction already has its outcome'

function response(
  status: number,
  payload: unknown = { error: { message: 'slow down' } },
): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    text: JSON.stringify(payload),
  }
}

/**
 * One timer a request set: how long it was set for, whether it was
 * cancelled, and the function that fires it.
 */
type FakeTimer = { ms: number; isCancelled: boolean; fire: () => void }

/**
 * Ports that answer the given statuses in order and keep what was asked of
 * them; `canPause` false stands for a hook with no time left to wait.
 * `fetch` replaces the answering when a test needs a request that fails,
 * throws or never settles; it is called as given, so a function that is not
 * `async` can throw before any promise exists. `pause` replaces the wait in
 * the same way, and is handed the signal the wait was given; every such
 * signal is kept in `pauseSignals`. Timers never fire unless the test fires
 * them.
 */
function portsOf(
  statuses: readonly number[],
  over: {
    canPause?: boolean
    fetch?: () => Promise<HttpResponse>
    pause?: (signal: AbortSignal) => Promise<boolean>
  } = {},
) {
  const sent: { url: string; init: HttpInit }[] = []
  const pauses: number[] = []
  const pauseSignals: AbortSignal[] = []
  const timers: FakeTimer[] = []
  const controller = new AbortController()

  return {
    sent,
    pauses,
    pauseSignals,
    timers,
    controller,
    ports: {
      fetch: (url: string, init: HttpInit) => {
        sent.push({ url, init })

        if (over.fetch !== undefined) {
          return over.fetch()
        }

        const status = statuses[sent.length - 1] ?? 500

        return Promise.resolve(
          status === 200 ? response(200, OK) : response(status),
        )
      },
      pause: (ms: number, signal: AbortSignal) => {
        pauses.push(ms)
        pauseSignals.push(signal)

        return over.pause?.(signal) ?? Promise.resolve(over.canPause ?? true)
      },
      after: (ms: number, fn: () => void) => {
        const timer: FakeTimer = { ms, isCancelled: false, fire: fn }

        timers.push(timer)

        return {
          cancel: () => {
            timer.isCancelled = true
          },
        }
      },
      signal: controller.signal,
    },
  }
}

/**
 * The attempt of one compaction over the given ports, and an asker on it.
 */
function askingOn(
  world: ReturnType<typeof portsOf>,
  route: Route = routeOf('typesafe'),
  credentials: Credentials = CREDENTIALS,
  isDecisive = true,
) {
  const attempt = attemptOf(world.ports)

  return {
    attempt,
    ask: askerOf(route, credentials, attempt, isDecisive),
  }
}

/**
 * A request that is accepted and never answered.
 */
function silence(): Promise<never> {
  return new Promise(() => {})
}

/**
 * A wait that ends only when its signal aborts, and then rejects with the
 * signal's reason, as the engine's `$.clock.sleep` does.
 */
function abortable(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    })
  })
}

/**
 * Whether each signal has aborted, and the message of its reason.
 */
function endsOf(signals: readonly AbortSignal[]) {
  return signals.map(signal => [
    signal.aborted,
    signal.reason instanceof Error ? signal.reason.message : undefined,
  ])
}

/**
 * Lets every promise turn that is already due run.
 */
async function quiet(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    await Promise.resolve()
  }
}

describe('askerOf', () => {
  test('success: the backoff stays under two seconds in all', () => {
    expect(BACKOFF_MS).toEqual([400, 1200])
    expect(BACKOFF_MS[0] + BACKOFF_MS[1] <= 2000).toBe(true)
  })

  const retried: Record<string, { statuses: number[]; pauses: number[] }> = {
    'success: a first answer needs no wait': { statuses: [200], pauses: [] },
    'success: a 429 is retried once after the first wait': {
      statuses: [429, 200],
      pauses: [400],
    },
    'success: a 529 then a 503 are retried twice': {
      statuses: [529, 503, 200],
      pauses: [400, 1200],
    },
  }

  for (const [name, { statuses, pauses }] of Object.entries(retried)) {
    test(name, async () => {
      const world = portsOf(statuses)
      const { attempt, ask } = askingOn(world)
      const reply = await ask('state', QUESTIONS)

      expect(reply.answers).toEqual(OK.answers)
      expect(world.sent).toHaveLength(statuses.length)
      expect(world.pauses).toEqual(pauses)
      expect(
        new Set(world.sent.map(request => request.init.body)).size,
        'the same body each time',
      ).toBe(1)
      expect(
        world.timers.map(timer => [timer.ms, timer.isCancelled]),
        'one deadline for the whole attempt, still armed while it is open',
      ).toEqual([[COMPACTION_DEADLINE_MS, false]])

      attempt.close()

      expect(world.timers[0]?.isCancelled, 'closing releases it').toBe(true)
    })
  }

  const failed: Record<
    string,
    {
      statuses: number[]
      canPause?: boolean
      attempts: number
      pauses: number[]
      message: string
    }
  > = {
    'error: a third 429 is final': {
      statuses: [429, 429, 429, 200],
      attempts: 3,
      pauses: [400, 1200],
      message: 'typesafe answered HTTP 429: slow down',
    },
    'error: a 401 is final at once': {
      statuses: [401, 200],
      attempts: 1,
      pauses: [],
      message: 'typesafe answered HTTP 401: slow down',
    },
    'error: a 422 is final at once': {
      statuses: [422, 200],
      attempts: 1,
      pauses: [],
      message: 'typesafe answered HTTP 422: slow down',
    },
    'error: with no time left to wait a 500 is not retried': {
      statuses: [500, 200],
      canPause: false,
      attempts: 1,
      pauses: [400],
      message: 'typesafe answered HTTP 500: slow down',
    },
  }

  for (const [
    name,
    { statuses, canPause, attempts, pauses, message },
  ] of Object.entries(failed)) {
    test(name, async () => {
      const world = portsOf(statuses, { canPause })
      const { attempt, ask } = askingOn(world)

      await expect(ask('state', QUESTIONS)).rejects.toThrow({ message })
      expect(world.sent).toHaveLength(attempts)
      expect(world.pauses).toEqual(pauses)
      expect(
        attempt.failure()?.message,
        'a decisive failure ends the attempt with its own reason',
      ).toBe(message)
      expect(
        world.timers[0]?.isCancelled,
        'and releases the deadline at once',
      ).toBe(true)
    })
  }

  test('error: a missing credential fails before anything is sent', async () => {
    const world = portsOf([200])
    const { ask } = askingOn(world, routeOf('typesafe'), {})

    await expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: 'typesafe is not configured: TYPESAFE_API_KEY is unset',
    })
    expect(world.sent).toEqual([])
  })

  test('error: a failure of a request the compaction can do without leaves the attempt open', async () => {
    const world = portsOf([401, 200])
    const attempt = attemptOf(world.ports)
    const optional = askerOf(routeOf('typesafe'), CREDENTIALS, attempt, false)
    const decisive = askerOf(routeOf('typesafe'), CREDENTIALS, attempt, true)

    await expect(optional('state', QUESTIONS)).rejects.toThrow({
      message: 'typesafe answered HTTP 401: slow down',
    })
    expect(attempt.failure()).toBeUndefined()
    expect((await decisive('state', QUESTIONS)).answers).toEqual(OK.answers)
    expect(world.sent).toHaveLength(2)
  })
})

describe('one compaction, one bound', () => {
  test('success: the bound is thirty seconds', () => {
    expect(COMPACTION_DEADLINE_MS).toBe(30_000)
  })

  test('success: every request of an attempt runs under the one deadline armed for it', async () => {
    const world = portsOf([200, 429, 200, 200])
    const { attempt, ask } = askingOn(world)

    await ask('state', QUESTIONS)
    await ask('state', QUESTIONS)
    await ask('state', QUESTIONS)

    expect(world.sent, 'four requests, one of them a retry').toHaveLength(4)
    expect(world.timers.map(timer => timer.ms)).toEqual([30_000])

    attempt.close()
  })

  test('error: requests never answered fail together when the deadline passes, and nothing is retried', async () => {
    const world = portsOf([], { fetch: silence })
    const { attempt, ask } = askingOn(world)
    const first = expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: DEADLINE_MESSAGE,
    })
    const second = expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: DEADLINE_MESSAGE,
    })

    await quiet()

    expect(world.sent, 'both requests are out').toHaveLength(2)

    world.timers[0]?.fire()

    await first
    await second
    expect(world.sent, 'no attempt after the deadline').toHaveLength(2)
    expect(world.pauses).toEqual([])
    expect(attempt.failure()?.message).toBe(DEADLINE_MESSAGE)
    await expect(
      ask('state', QUESTIONS),
      'a request asked for after it is refused unsent',
    ).rejects.toThrow({ message: DEADLINE_MESSAGE })
    expect(world.sent).toHaveLength(2)
  })

  test('error: a compaction given up while a request is out abandons the request', async () => {
    const world = portsOf([], { fetch: silence })
    const { attempt, ask } = askingOn(world, routeOf('cloudflare'), {
      cloudflareApiToken: 'test-cloudflare-token',
      cloudflareAccountId: 'a',
    })
    const settled = expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: INTERRUPTED_MESSAGE,
    })

    world.controller.abort()

    await settled
    expect(world.timers.map(timer => timer.isCancelled)).toEqual([true])

    attempt.close()
  })

  test('error: a compaction given up while it waits to retry sends nothing more', async () => {
    const world = portsOf([429, 200], { pause: silence })
    const { ask } = askingOn(world)
    const settled = expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: INTERRUPTED_MESSAGE,
    })

    await quiet()

    expect(world.pauses, 'the wait has begun').toEqual([400])

    world.controller.abort()

    await settled
    expect(world.sent, 'the retry is never sent').toHaveLength(1)
  })

  test('error: a compaction already given up sends nothing and arms nothing', async () => {
    const world = portsOf([200])

    world.controller.abort()

    const { ask } = askingOn(world)

    await expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: INTERRUPTED_MESSAGE,
    })
    expect(world.sent).toEqual([])
    expect(world.timers).toEqual([])
  })

  test('error: once one batch has failed for good no other batch retries or waits', async () => {
    // Two batches are out. The second is refused with a 401; only then does
    // the first come back with a 429, which would be retried after a wait if
    // the compaction were still open.
    const answers: ((value: HttpResponse) => void)[] = []
    const world = portsOf([], {
      fetch: () => new Promise(resolve => answers.push(resolve)),
    })
    const { attempt, ask } = askingOn(world)
    const first = expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: 'typesafe answered HTTP 401: slow down',
    })
    const second = expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: 'typesafe answered HTTP 401: slow down',
    })

    await quiet()
    answers[1]?.(response(401))
    await second

    answers[0]?.(response(429))
    await first

    expect(world.sent, 'the two requests and no retry').toHaveLength(2)
    expect(world.pauses, 'and no wait').toEqual([])
    expect(attempt.failure()?.message).toBe(
      'typesafe answered HTTP 401: slow down',
    )
  })

  test('error: a wait under way is aborted the moment the attempt fails', async () => {
    const world = portsOf([429, 200], { pause: abortable })
    const { attempt, ask } = askingOn(world)
    const settled = expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: 'another batch was refused',
    })

    await quiet()

    expect(world.pauses, 'the wait has begun').toEqual([400])
    expect(endsOf(world.pauseSignals), 'and is still under way').toEqual([
      [false, undefined],
    ])

    attempt.fail(new Error('another batch was refused'))

    await settled
    expect(endsOf(world.pauseSignals)).toEqual([
      [true, 'another batch was refused'],
    ])
    expect(world.sent, 'the retry is never sent').toHaveLength(1)
  })

  test('error: once closed, an attempt sends nothing and waits for nothing', async () => {
    const world = portsOf([200])
    const { attempt, ask } = askingOn(world)

    attempt.close()

    expect(attempt.failure()?.message).toBe(CLOSED_MESSAGE)
    await expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: CLOSED_MESSAGE,
    })
    await expect(attempt.pause(400)).rejects.toThrow({
      message: CLOSED_MESSAGE,
    })
    expect(world.sent).toEqual([])
    expect(world.pauses).toEqual([])
    expect(world.timers.map(timer => timer.isCancelled)).toEqual([true])
  })

  test('error: closing ends a wait still under way, and its retry is never sent', async () => {
    const world = portsOf([429, 200], { pause: abortable })
    const { attempt, ask } = askingOn(world)
    const settled = expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: CLOSED_MESSAGE,
    })

    await quiet()

    expect(world.pauses, 'the wait has begun').toEqual([400])

    attempt.close()

    await settled
    expect(endsOf(world.pauseSignals)).toEqual([[true, CLOSED_MESSAGE]])
    expect(world.sent).toHaveLength(1)
  })

  test('error: an attempt whose deadline cannot be armed leaves nothing on the signal', () => {
    const world = portsOf([200])
    const listeners = listenersOf(world.ports.signal)

    world.ports.after = () => {
      throw new Error('no timer may be set now')
    }

    expect(() => attemptOf(world.ports)).toThrow({
      message: 'no timer may be set now',
    })
    expect(listeners.added(), 'the listener went on first').toBe(1)
    expect(listeners.live.size, 'and came off again').toBe(0)
  })

  test('error: a request the host rejects fails with its reason, redacted', async () => {
    const world = portsOf([], {
      fetch: async () => {
        throw new Error(
          'refused: POST with authorization: Bearer test-typesafe-key',
        )
      },
    })
    const { ask } = askingOn(world)

    await expect(ask('state', QUESTIONS)).rejects.toThrow({
      message:
        'the request to typesafe failed: refused: POST with authorization: [redacted]',
    })
    expect(world.timers.map(timer => timer.isCancelled)).toEqual([true])
  })

  test('error: a host that throws instead of rejecting is handled like a rejection, and nothing stays armed', async () => {
    const world = portsOf([], {
      fetch: () => {
        throw new Error('refused on the spot; Bearer: test-typesafe-key')
      },
    })
    const { attempt, ask } = askingOn(world)

    await expect(ask('state', QUESTIONS)).rejects.toThrow({
      message:
        'the request to typesafe failed: refused on the spot; [redacted]',
    })
    expect(attempt.failure()?.message).toBe(
      'the request to typesafe failed: refused on the spot; [redacted]',
    )
    expect(world.timers.map(timer => timer.isCancelled)).toEqual([true])

    // The deadline firing late, as a timer the engine had already queued
    // might, changes nothing and rejects nothing.
    world.timers[0]?.fire()
    world.controller.abort()
    await quiet()

    expect(attempt.failure()?.message).toBe(
      'the request to typesafe failed: refused on the spot; [redacted]',
    )
  })

  test("error: the host's reason is cut to one short line", async () => {
    const world = portsOf([], {
      fetch: async () => {
        throw new Error(`refused:\n${'x'.repeat(400)}`)
      },
    })
    const { ask } = askingOn(world)

    await expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: `the request to typesafe failed: refused: ${'x'.repeat(151)}…`,
    })
  })

  test('error: an error body that repeats the key is quoted without it', async () => {
    const world = portsOf([], {
      fetch: async () =>
        response(401, {
          error: { message: 'the key test-typesafe-key is not valid' },
        }),
    })
    const { ask } = askingOn(world)

    await expect(ask('state', QUESTIONS)).rejects.toThrow({
      message: 'typesafe answered HTTP 401: the key [redacted] is not valid',
    })
  })
})
