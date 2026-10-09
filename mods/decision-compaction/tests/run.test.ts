import type { HttpInit, HttpResponse } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { configOf } from '../hooks/config'
import { run } from '../hooks/run'
import type { Job } from '../hooks/run'
import { listenersOf, readsOf } from './fixtures'

/**
 * Cloudflare takes 64 questions a request, so 32 calls go in a batch.
 */
const OPTIONS = { provider: 'cloudflare', preserveRecentMessages: 0 }
const CREDENTIALS = {
  cloudflareApiToken: 'test-cloudflare-token',
  cloudflareAccountId: 'test-account',
}
const MISSING_MESSAGE = 'no probability from 0 to 1 was answered for call_t1'
const REFUSED_MESSAGE = 'cloudflare answered HTTP 401: Invalid token'
const DEADLINE_MESSAGE =
  'the requests of this compaction were not all answered within 30 seconds'
const INTERRUPTED_MESSAGE =
  'the compaction was interrupted before its requests were answered'

/**
 * A Cloudflare response carrying these answers.
 */
function envelopeOf(answers: Record<string, unknown>): HttpResponse {
  return {
    status: 200,
    ok: true,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify({
      result: { model: 'clef', answers, usage: { input_tokens: 1000 } },
      success: true,
      errors: [],
      messages: [],
    }),
  }
}

/**
 * The response that answers every question of a request with 0.9.
 */
function answeredAll(init: HttpInit): HttpResponse {
  const { questions } = JSON.parse(init.body ?? '{}') as {
    questions: Record<string, unknown>
  }

  return envelopeOf(
    Object.fromEntries(
      Object.keys(questions).map(id => [id, { type: 'noul', noul: 0.9 }]),
    ),
  )
}

/**
 * A Cloudflare error response.
 */
function refused(status: number, message: string): HttpResponse {
  return {
    status,
    ok: false,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify({ success: false, errors: [{ message }] }),
  }
}

/**
 * Ports over fakes that keep count of what was started on them.
 *
 * `respond` answers the request numbered `count` (from 1) at once by
 * returning a response, or holds it by returning undefined; a held request
 * is answered from the test through `held`. A wait ends at once with true,
 * and the signal it was given is kept. The engine's signal is a real one
 * whose `abort` listeners are tracked; the deadline's timer fires only when
 * the test fires it.
 */
function worldOf(
  respond: (init: HttpInit, count: number) => HttpResponse | undefined,
) {
  const controller = new AbortController()
  const listeners = listenersOf(controller.signal)
  const world = {
    fetches: 0,
    pauses: [] as number[],
    pauseSignals: [] as AbortSignal[],
    held: [] as ((response: HttpResponse) => void)[],
    timers: [] as { ms: number; cancels: number; fire: () => void }[],
    listeners,
    controller,
  }
  const ports: Job['ports'] = {
    fetch: (url, init) => {
      world.fetches++

      const response = respond(init, world.fetches)

      return response === undefined
        ? new Promise(resolve => world.held.push(resolve))
        : Promise.resolve(response)
    },
    pause: (ms, signal) => {
      world.pauses.push(ms)
      world.pauseSignals.push(signal)

      return Promise.resolve(true)
    },
    after: (ms, fn) => {
      const timer = { ms, cancels: 0, fire: fn }

      world.timers.push(timer)

      return {
        cancel: () => {
          timer.cancels++
        },
      }
    },
    signal: controller.signal,
  }

  return { world, ports }
}

/**
 * Runs a compaction of `reads` answered Read calls over the ports, and
 * resolves with 'resolved' or with the message it threw; it never rejects.
 */
function runOver(reads: number, ports: Job['ports']): Promise<string> {
  return run({
    messages: readsOf(reads),
    config: configOf(OPTIONS),
    credentials: CREDENTIALS,
    ports,
  }).then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.message : 'thrown'),
  )
}

/**
 * Lets every promise turn that is already due run, and the turns they start.
 */
async function quiet(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    await Promise.resolve()
  }
}

describe('run', () => {
  test('error: a reply that lacks an answer ends the compaction at once, and nothing is sent or waited for after it', async () => {
    // Five batches, three out at a time. The three come back in one turn:
    // the first without the answers it needs, which is found where the
    // answers are read, outside the request itself; the second and third
    // with a 429, which would be retried after a wait if the compaction
    // were still open. Their waits begin before the missing answer is
    // found, and must end with the compaction as soon as it is.
    const { world, ports } = worldOf((init, count) =>
      count <= 3 ? undefined : refused(429, 'Rate limit exceeded'),
    )
    const settled = runOver(160, ports)

    await quiet()

    expect(world.fetches, 'three batches go out at once').toBe(3)

    world.held[0]?.(envelopeOf({}))
    world.held[1]?.(refused(429, 'Rate limit exceeded'))
    world.held[2]?.(refused(429, 'Rate limit exceeded'))

    expect(await settled).toBe(MISSING_MESSAGE)
    expect(world.fetches, 'no batch and no retry is sent').toBe(3)
    expect(world.pauses, 'the waits begun before it was found').toEqual([
      400, 400,
    ])
    expect(
      world.pauseSignals.map(signal => [
        signal.aborted,
        signal.reason instanceof Error ? signal.reason.message : undefined,
      ]),
      'end with the reason the compaction ended for',
    ).toEqual([
      [true, MISSING_MESSAGE],
      [true, MISSING_MESSAGE],
    ])

    await quiet()

    expect(world.fetches, 'nothing is sent after run settled').toBe(3)
    expect(world.pauses, 'and nothing is waited for').toHaveLength(2)
  })

  const exits: Record<
    string,
    {
      respond: (init: HttpInit, count: number) => HttpResponse | undefined
      act?: (world: ReturnType<typeof worldOf>['world']) => void
      settles: string
    }
  > = {
    'success: the deadline and the listener are released when every batch is answered':
      {
        respond: init => answeredAll(init),
        settles: 'resolved',
      },
    'error: the deadline and the listener are released when a batch fails for good':
      {
        respond: () => refused(401, 'Invalid token'),
        settles: REFUSED_MESSAGE,
      },
    'error: the deadline and the listener are released when the deadline passes':
      {
        respond: () => undefined,
        act: world => world.timers[0]?.fire(),
        settles: DEADLINE_MESSAGE,
      },
    'error: the deadline and the listener are released when the compaction is given up mid-flight':
      {
        respond: () => undefined,
        act: world => world.controller.abort(),
        settles: INTERRUPTED_MESSAGE,
      },
  }

  for (const [name, { respond, act, settles }] of Object.entries(exits)) {
    test(name, async () => {
      const { world, ports } = worldOf(respond)
      const settled = runOver(3, ports)

      await quiet()

      expect(world.fetches, 'the one batch is out').toBe(1)
      expect(
        world.timers.map(timer => timer.ms),
        'one deadline armed',
      ).toEqual([30_000])
      expect(world.listeners.added(), 'one listener on the signal').toBe(1)

      act?.(world)

      expect(await settled).toBe(settles)
      expect(
        world.timers.map(timer => timer.cancels),
        'the deadline is cancelled exactly once',
      ).toEqual([1])
      expect(
        world.listeners.live.size,
        'and the listener is taken off the signal',
      ).toBe(0)
    })
  }
})
