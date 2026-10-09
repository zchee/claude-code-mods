import type { HttpInit, HttpResponse } from 'claude-code'

import type { Ask } from './compact'
import { briefOf, exchangeOf, isRetryable, replyFrom } from './providers'
import type { Credentials, Route } from './providers'

/**
 * What a request needs from the engine, handed in as functions because the
 * engine interface itself cannot leave the hooks module's own file.
 */
export type Ports = {
  /**
   * `$.http.fetch`.
   */
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  /**
   * Waits before a retry. Resolves false, without waiting, when the hook has
   * no time left to spend on it. `signal` aborts when the attempt the wait
   * belongs to is over, and the wait must end with it then: a wait that
   * outlived its attempt would hold the hook for nothing.
   */
  pause: (ms: number, signal: AbortSignal) => Promise<boolean>
  /**
   * `$.clock.after`: runs `fn` once after `ms` milliseconds unless the
   * answer's `cancel` is called first.
   */
  after: (ms: number, fn: () => void) => { cancel: () => void }
  /**
   * `next.signal`: aborts when the compaction this hook serves is given up.
   */
  signal: AbortSignal
}

/**
 * How long to wait before the second and the third attempt of one request.
 * The hook's own code and its waits are charged to its ten seconds; the time
 * a request is out is not. The two waits of one request stay under two
 * seconds together, but that bound is per request, not per compaction: with
 * `MAX_REQUESTS` batches going out `CONCURRENT_REQUESTS` at a time, as many
 * rounds of batches as that makes (six, at sixteen and three) can each wait
 * in turn. What bounds the waits of a compaction together is the `pause`
 * port, which declines a wait when the hook has too little of its time left.
 */
export const BACKOFF_MS = [400, 1200] as const

/**
 * How long one compaction may wait on its providers, from the moment its
 * first request can go out: the routing question, every batch, every retry
 * and every wait between retries together. A request has no timeout of its
 * own, and the time it takes is not charged to the hook, so without a bound
 * a provider that accepts a request and never answers would hold the
 * compaction open for good, and the built-in summary would never get its
 * turn. The bound is the longest the person waits on the providers, with the
 * session paused, before that summary starts.
 */
export const COMPACTION_DEADLINE_MS = 30_000

/**
 * The requests and waits of one compaction, under the one bound they share.
 *
 * The compaction is over, as far as its providers go, at the first of: its
 * deadline passing, the engine giving the compaction up, `fail` being
 * called, or `close` being called. From then on `fetch` and `pause` start
 * nothing and reject with the reason. When it is over for any reason but
 * `close`, whatever they had under way rejects with it at once; however it
 * ends, a wait under way is aborted. A request that is out cannot be
 * withdrawn, so its late answer is ignored.
 */
export type Attempt = {
  /**
   * `Ports.fetch`, started only while the compaction is not over. A request
   * the host refuses by throwing, instead of by rejecting, rejects all the
   * same.
   */
  fetch: Ports['fetch']
  /**
   * `Ports.pause`, started only while the compaction is not over, with a
   * signal that aborts when it is.
   */
  pause: (ms: number) => Promise<boolean>
  /**
   * Why the compaction is over, or undefined while it is not.
   */
  failure: () => Error | undefined
  /**
   * Ends the compaction with a reason. Only the first reason counts.
   */
  fail: (reason: Error) => void
  /**
   * Ends the compaction, when nothing ended it before, and releases the
   * deadline's timer and the listener on the engine's signal. Called once
   * the compaction has its outcome, whichever that is: a request still out
   * then has nobody to answer, and must not retry or wait.
   */
  close: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Puts one compaction's requests under one deadline, armed here and nowhere
 * else, and under the engine's signal.
 *
 * @param ports the engine calls
 * @returns the attempt; the caller closes it when the compaction is decided
 */
export function attemptOf(ports: Ports): Attempt {
  let failure: Error | undefined
  let disarm = () => {}
  let reject: (reason: Error) => void = () => {}
  // Aborted when the attempt is over, however it ends: the waits listen to
  // it, so that none of them outlives the attempt.
  const ended = new AbortController()

  const cut = new Promise<never>((_resolve, rejectCut) => {
    reject = rejectCut
  })

  // An end that comes while nothing is under way has nobody to reach, and
  // must not surface as a rejection nobody handled.
  cut.catch(() => {})

  const fail = (reason: Error) => {
    if (failure !== undefined) {
      return
    }

    failure = reason
    disarm()
    reject(reason)
    ended.abort(reason)
  }

  const interrupted = () =>
    new Error(
      'the compaction was interrupted before its requests were answered',
    )

  if (ports.signal.aborted) {
    fail(interrupted())
  } else {
    const onAbort = () => fail(interrupted())

    // Neither is left set up without the other: the listener goes on first
    // and comes off again when the timer cannot be armed, so an attempt that
    // could not be made leaves nothing on the engine's signal or its clock.
    ports.signal.addEventListener('abort', onAbort, { once: true })

    let timer: { cancel: () => void }

    try {
      timer = ports.after(COMPACTION_DEADLINE_MS, () =>
        fail(
          new Error(
            'the requests of this compaction were not all answered within ' +
              `${COMPACTION_DEADLINE_MS / 1000} seconds`,
          ),
        ),
      )
    } catch (error) {
      ports.signal.removeEventListener('abort', onAbort)

      throw error
    }

    disarm = () => {
      disarm = () => {}
      timer.cancel()
      ports.signal.removeEventListener('abort', onAbort)
    }
  }

  // The executor turns a `start` that throws into a rejection, so a call
  // refused on the spot takes the same path as one refused later.
  const within = <Value>(start: () => Promise<Value>): Promise<Value> =>
    failure === undefined
      ? Promise.race([new Promise<Value>(resolve => resolve(start())), cut])
      : Promise.reject(failure)

  return {
    fetch: (url, init) => within(() => ports.fetch(url, init)),
    pause: ms => within(() => ports.pause(ms, ended.signal)),
    failure: () => failure,
    fail,
    // The shared cut is not rejected here: whatever is still out when the
    // outcome is known is waited on by nobody and is left to settle on its
    // own. Only what it would start from here on is refused.
    close: () => {
      failure ??= new Error('the compaction already has its outcome')
      disarm()
      ended.abort(failure)
    },
  }
}

/**
 * Builds the function that sends one set of questions over a route.
 *
 * A response that may succeed on another attempt (rate limiting, an
 * overloaded or failing server) is retried after a short wait, at most
 * twice; any other failure is final at once. Only this one route is ever
 * tried: there is no falling over to another provider.
 *
 * A failure of a decisive request ends the attempt on the spot, in the same
 * step that found it, so that no other request of the compaction retries or
 * waits after it. Once the attempt is over, every request fails with the
 * attempt's reason, whatever its own would have been.
 *
 * What the host says when it refuses a call is quoted redacted and short:
 * it may repeat the request's headers.
 *
 * @param route the provider and model
 * @param credentials the resolved credentials
 * @param attempt the compaction's requests and their shared bound
 * @param isDecisive true for a request the compaction cannot do without (a
 * batch of questions about calls), false for one it can (the routing
 * question)
 * @returns the function `compact` and the routing decision ask through
 */
export function askerOf(
  route: Route,
  credentials: Credentials,
  attempt: Attempt,
  isDecisive: boolean,
): Ask {
  const hosted = <Value>(what: string, call: Promise<Value>): Promise<Value> =>
    call.catch(error => {
      throw (
        attempt.failure() ??
        new Error(`${what} failed: ${briefOf(messageOf(error), credentials)}`)
      )
    })

  return async (state, questions) => {
    try {
      const exchange = exchangeOf(route, credentials, state, questions)
      const send = () =>
        hosted(
          `the request to ${route.provider}`,
          attempt.fetch(exchange.url, exchange.init),
        )

      let response = await send()

      for (const wait of BACKOFF_MS) {
        if (response.ok || !isRetryable(response.status)) {
          break
        }

        const waited = hosted(
          `the wait before asking ${route.provider} again`,
          attempt.pause(wait),
        )

        if (!(await waited)) {
          break
        }

        response = await send()
      }

      return replyFrom(route, response, credentials, questions)
    } catch (error) {
      const reason =
        attempt.failure() ??
        (error instanceof Error ? error : new Error(String(error)))

      if (isDecisive) {
        attempt.fail(reason)
      }

      throw reason
    }
  }
}
