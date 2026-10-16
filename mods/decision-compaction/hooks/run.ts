import type { SessionMessage } from 'claude-code'

import { askerOf, attemptOf } from './ask'
import type { Ports } from './ask'
import {
  batchesOf,
  budgetOf,
  compact,
  demandOf,
  LIMIT_SHARE,
  untouched,
} from './compact'
import type { Budget, Outcome } from './compact'
import { eligibleOf } from './config'
import type { Config } from './config'
import {
  assertConfigured,
  bytesBesideOf,
  limitsOf,
  messageOf,
  routeOf,
  wantedOf,
  wireOf,
} from './providers'
import type { Credentials, Route } from './providers'
import { chooseRoute, profileOf } from './route'
import { estimatedTokensOf, goalOf, pairCalls, stateWithin } from './state'
import type { Fitted } from './state'

/**
 * One compaction to carry out.
 */
export type Job = {
  messages: readonly SessionMessage[]
  /**
   * The instructions given with the compaction, when there were any.
   */
  instructions?: string
  config: Config
  credentials: Credentials
  ports: Ports
}

/**
 * A compaction carried out: the outcome, the route it went over, and how
 * the route was picked when the decision was on.
 */
export type Result = {
  outcome: Outcome
  route: Route
  routing?: string
  /**
   * The bytes the route asks a request body to stay within, at the share
   * it is held to, and whether every request did; absent for a route that
   * asks for no such cap.
   */
  askedBytes?: { limit: number; isHeld: boolean }
}

/**
 * Carries out one compaction from the transcript to the rebuilt messages.
 *
 * The state is fitted once, against the configured provider's limits and
 * wire format, a cap on the body in bytes included, and every request that
 * asks about a call then goes over one route: the configured one, or the
 * one the provider decision picked. A route whose wire format carries the
 * state differently is held to the state's size in that format. A failure
 * anywhere throws; the caller falls back to the built-in summary.
 *
 * Everything sent to a provider, the routing question included, is sent
 * inside one attempt: one deadline, armed here once the state is fitted and
 * released when the outcome is known. Past it, on the engine's signal, and
 * at the first request about tool calls that fails for good, whatever is
 * still out is abandoned, nothing further is sent or waited for, and this
 * throws the one reason. The routing question failing is not such an end:
 * the configured route decides instead. Once the outcome is known, whatever
 * is still out starts nothing more.
 *
 * Options that carry a refusal are not acted on at all: they name no
 * provider the person chose, so nothing may be sent anywhere.
 *
 * @param job the transcript, the configuration, the credentials, the ports
 * @returns the result
 */
export async function run(job: Job): Promise<Result> {
  const { messages, config, credentials, ports } = job

  if (config.refusal !== undefined) {
    throw new Error(config.refusal)
  }

  const configured = routeOf(config.provider, config.model)

  if (!config.providerDecision) {
    assertConfigured(configured.provider, credentials)
  }

  const calls = pairCalls(messages, config.preserveRecentMessages)
  const unpinned = calls.filter(call => !call.isPinned)

  if (unpinned.length === 0) {
    return { outcome: untouched(messages, calls), route: configured }
  }

  const demandFor = (route: Route) =>
    demandOf(unpinned, wireOf(route), limitsOf(route).maxQuestions)
  // A budget the person left unset is the one the route asks for, so a
  // provider decision weighs each route by its own.
  const budgetFor = (route: Route) =>
    budgetOf(
      {
        maxStateTokens: config.maxStateTokens ?? wantedOf(route).maxStateTokens,
        maxRequestTokens:
          config.maxRequestTokens ?? wantedOf(route).maxRequestTokens,
      },
      limitsOf(route),
      demandFor(route),
    )
  // The cap on the body in bytes a route asks for but does not require,
  // while the person has set no request budget of their own.
  const askedBytesOf = (route: Route) =>
    limitsOf(route).maxRequestBytes === undefined &&
    config.maxRequestTokens === undefined
      ? wantedOf(route).maxRequestBytes
      : undefined
  // What each route is held to over one fitted state: the state as its wire
  // format carries it, the cap on its body in bytes when it has one, and
  // its budget.
  const planOf = (fitted: Fitted) => {
    const stateJson = JSON.stringify(fitted.state)
    const fittedFor = (route: Route): Fitted =>
      wireOf(route) === wireOf(configured)
        ? fitted
        : {
            ...fitted,
            tokens: estimatedTokensOf(wireOf(route).stateJsonOf(stateJson)),
          }
    // A route that caps the body in bytes is held to the bytes the state
    // takes in its request as written, counted exactly, and to the same
    // share of its cap as of its token limits: what a question will take is
    // still an estimate, and a body over the cap is refused whole.
    const heldTo = (route: Route, maxRequestBytes?: number): Budget => {
      const budget = budgetFor(route)

      return maxRequestBytes === undefined
        ? budget
        : {
            ...budget,
            bytes: {
              limit: Math.floor(maxRequestBytes * LIMIT_SHARE),
              state: bytesBesideOf(route, fitted.state),
            },
          }
    }
    // The cap the provider requires; or the one the route asks for, where
    // the questions about every call go in the requests a compaction may
    // send under it; or none.
    const bytesOn = (route: Route): number | undefined => {
      const routeAsked = askedBytesOf(route)

      if (routeAsked === undefined) {
        return limitsOf(route).maxRequestBytes
      }

      try {
        batchesOf(
          unpinned,
          fittedFor(route).tokens,
          heldTo(route, routeAsked),
          wireOf(route),
        )
      } catch {
        return undefined
      }

      return routeAsked
    }

    return {
      fittedFor,
      bytesOn,
      budgetOn: (route: Route) => heldTo(route, bytesOn(route)),
    }
  }
  const goal = goalOf(messages, job.instructions)
  const fitTo = (maxRequestBytes: number | undefined) =>
    stateWithin(messages, calls, {
      maxStateTokens: budgetFor(configured).stateTokens,
      preserveRecentMessages: config.preserveRecentMessages,
      goal,
      wire: wireOf(configured),
      // Held to the same share of a byte cap as the request is below, with
      // the bytes of one request's questions left free.
      ...(maxRequestBytes === undefined
        ? {}
        : {
            bytes: {
              limit:
                Math.floor(maxRequestBytes * LIMIT_SHARE) -
                demandFor(configured).batchBytes,
              besideOf: (state: unknown) => bytesBesideOf(configured, state),
            },
          }),
    })
  const asked = askedBytesOf(configured)
  let fitted: Fitted
  let isFittedToAsked = asked !== undefined

  // A cap the route only asks for gives way when the conversation cannot be
  // fitted under it, rather than fail the compaction the way a cap the
  // provider requires does.
  try {
    fitted = fitTo(limitsOf(configured).maxRequestBytes ?? asked)
  } catch (error) {
    if (asked === undefined) {
      throw error
    }

    fitted = fitTo(undefined)
    isFittedToAsked = false
  }

  let plan = planOf(fitted)

  // A state fitted under an asked-for cap whose calls would still not go
  // in the requests a compaction may send is fitted again without it: the
  // cap is not kept, so the detail given up for it need not be.
  if (isFittedToAsked && plan.bytesOn(configured) === undefined) {
    fitted = fitTo(undefined)
    plan = planOf(fitted)
  }

  const { fittedFor, budgetOn, bytesOn } = plan
  const attempt = attemptOf(ports)

  try {
    const result: Pick<Result, 'route' | 'routing'> = { route: configured }

    if (config.providerDecision) {
      const routed = await chooseRoute(
        configured,
        eligibleOf(config),
        credentials,
        route => {
          try {
            const budget = budgetOn(route)
            const { tokens } = fittedFor(route)

            if (tokens > budget.stateTokens) {
              return (
                `the state is about ${tokens} tokens and it takes ` +
                `${budget.stateTokens}`
              )
            }

            batchesOf(unpinned, tokens, budget, wireOf(route))
          } catch (error) {
            return messageOf(error)
          }

          return undefined
        },
        profileOf(messages, unpinned, fitted.tokens, goal),
        // The routing question is one the compaction can do without: when
        // it fails, the configured route decides.
        route => askerOf(route, credentials, attempt, false),
      )
      const failure = attempt.failure()

      // A routing question cut off by the deadline or the engine's signal
      // is not a reason to go on with the configured route: the attempt is
      // over, and what ended it is the reason to give.
      if (failure !== undefined) {
        throw failure
      }

      result.route = routed.route
      result.routing = routed.why
    }

    const outcome = await compact(
      messages,
      calls,
      fittedFor(result.route),
      askerOf(result.route, credentials, attempt, true),
      {
        budget: budgetOn(result.route),
        wire: wireOf(result.route),
        keepThreshold: config.keepThreshold,
        truncateHeadChars: config.truncateHeadChars,
        halt: attempt.fail,
      },
    )
    const routeAsked = askedBytesOf(result.route)

    return routeAsked === undefined
      ? { ...result, outcome }
      : {
          ...result,
          outcome,
          askedBytes: {
            limit: Math.floor(routeAsked * LIMIT_SHARE),
            isHeld: bytesOn(result.route) !== undefined,
          },
        }
  } finally {
    attempt.close()
  }
}
