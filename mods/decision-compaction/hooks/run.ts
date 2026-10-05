import type { SessionMessage } from 'claude-code'

import { askerOf, attemptOf } from './ask'
import type { Ports } from './ask'
import { batchesOf, budgetOf, compact, demandOf, untouched } from './compact'
import type { Outcome } from './compact'
import type { Config } from './config'
import { assertConfigured, limitsOf, routeOf } from './providers'
import type { Credentials, Route } from './providers'
import { chooseRoute, profileOf } from './route'
import { goalOf, pairCalls, stateWithin } from './state'

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
}

/**
 * Carries out one compaction from the transcript to the rebuilt messages.
 *
 * The state is fitted once, against the configured provider's limits, and
 * every request that asks about a call then goes over one route: the
 * configured one, or the one the provider decision picked. A failure
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

  const demand = demandOf(unpinned)
  const budgetFor = (route: Route) =>
    budgetOf(config, limitsOf(route.provider), demand)
  const goal = goalOf(messages, job.instructions)
  const fitted = stateWithin(messages, calls, {
    maxStateTokens: budgetFor(configured).stateTokens,
    preserveRecentMessages: config.preserveRecentMessages,
    goal,
  })
  const attempt = attemptOf(ports)

  try {
    const result: Pick<Result, 'route' | 'routing'> = { route: configured }

    if (config.providerDecision) {
      const routed = await chooseRoute(
        configured,
        credentials,
        route => {
          try {
            const budget = budgetFor(route)

            if (fitted.tokens > budget.stateTokens) {
              return (
                `the state is about ${fitted.tokens} tokens and it takes ` +
                `${budget.stateTokens}`
              )
            }

            batchesOf(unpinned, fitted.tokens, budget)
          } catch (error) {
            return error instanceof Error ? error.message : String(error)
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
      fitted,
      askerOf(result.route, credentials, attempt, true),
      {
        budget: budgetFor(result.route),
        keepThreshold: config.keepThreshold,
        truncateHeadChars: config.truncateHeadChars,
        halt: attempt.fail,
      },
    )

    return { ...result, outcome }
  } finally {
    attempt.close()
  }
}
