import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { reductionOf } from './compact'
import { configOf } from './config'
import {
  briefOf,
  credentialsOf,
  environmentOf,
  PROVIDERS,
  redacted,
  unresolvedOf,
} from './providers'
import type { Credentials, Environment, ProviderName } from './providers'
import { decisionLinesOf, percentOf, summaryOf } from './report'
import { run } from './run'
import { armOf, isCompactionDue, settle } from './trigger'

/**
 * How long an outcome toast stays: long enough to read one full line.
 */
const TOAST_MS = 15_000

/**
 * The hook time that must remain after a retry's wait for the work that
 * follows it: reading the answers and rebuilding the messages.
 */
const PAUSE_RESERVE_MS = 1500

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reads the credential variables from the process environment, and from the
 * `env` block of the settings only while a credential one of the providers
 * needs is still without a value: the settings are a second source, not a
 * part of every compaction. Each name is spelled out because `$.env.get`
 * takes a string literal only.
 *
 * Settings that cannot be read are no settings. The compaction goes on with
 * what the options and the environment gave, and `problem` says what went
 * wrong so that it can be logged.
 */
async function readEnvironment(
  $: EngineInterface,
  options: PluginOptions,
  providers: readonly ProviderName[],
): Promise<{ environment: Environment; problem?: string }> {
  const read: Environment = {
    TYPESAFE_API_KEY: await $.env.get('TYPESAFE_API_KEY'),
    OPENROUTER_API_KEY: await $.env.get('OPENROUTER_API_KEY'),
    CLOUDFLARE_API_TOKEN: await $.env.get('CLOUDFLARE_API_TOKEN'),
    CLOUDFLARE_ACCOUNT_ID: await $.env.get('CLOUDFLARE_ACCOUNT_ID'),
  }

  if (unresolvedOf(providers, options, read).length === 0) {
    return { environment: environmentOf(read, undefined) }
  }

  try {
    const settings = await $.settings.read()

    return { environment: environmentOf(read, settings.env) }
  } catch (error) {
    return {
      environment: environmentOf(read, undefined),
      problem: messageOf(error),
    }
  }
}

/**
 * Writes one line to the transcript. Every line this module shows goes
 * through here or through `tell`, and so through `redacted`: whatever a
 * line was built from, no credential leaves in it.
 */
function log($: EngineInterface, text: string, credentials: Credentials): void {
  $.ui.log(redacted(text, credentials))
}

/**
 * Says one line both where it stays (the transcript) and where it is seen
 * at once (a toast), redacted like every other line.
 */
function tell(
  $: EngineInterface,
  text: string,
  credentials: Credentials,
): void {
  const shown = redacted(text, credentials)

  $.ui.log(shown)
  $.ui.toast(shown, { timeoutMs: TOAST_MS })
}

/**
 * Registers the two hooks.
 *
 * `session.compact` hands back the conversation itself in place of a
 * summary, less the tool calls and results a decision model judged no
 * longer needed. It
 * fails open: on any error, and when too little would be removed, it says
 * why in one line and hands the compaction on to the built-in summary.
 *
 * `turn.complete` requests a compaction once the main conversation's
 * context reaches `compactAtPercent`, one request at a time, and not again
 * while usage stays near what a compaction that could not get under the
 * threshold left.
 *
 * @param on the engine's registrar
 * @param options the plugin's options
 */
export const register: Register = (on, options) => {
  const config = configOf(options)
  const providers: readonly ProviderName[] = config.providerDecision
    ? PROVIDERS
    : [config.provider]

  on('session.compact', async ($, e, next) => {
    // A precompute installs nothing and its result is used only if the
    // conversation is still the same when a real compaction comes. Deciding
    // then would send the conversation to a third party, and pay for it,
    // for a result that may be thrown away; the engine's own precompute is
    // left to stand as the fallback this hook fails open to.
    if (e.trigger === 'precompute') {
      return next(e)
    }

    // Held outside the `try` so that the line written when it fails is
    // redacted with whatever had been resolved by then.
    let credentials: Credentials = {}
    let result

    try {
      // Options that name no provider the person chose are acted on in no
      // way: not even a credential is read for them.
      if (config.refusal !== undefined) {
        throw new Error(config.refusal)
      }

      // Credentials are read here, for this compaction, so a key set or
      // rotated after the module loaded is the one that is used. What the
      // host says when it refuses a read is its own text, so it is quoted
      // short like a provider's.
      const { environment, problem } = await readEnvironment(
        $,
        options,
        providers,
      ).catch(error => {
        throw new Error(
          `the environment could not be read: ${briefOf(messageOf(error), {})}`,
        )
      })

      credentials = credentialsOf(options, environment)

      if (problem !== undefined) {
        log(
          $,
          `the settings could not be read (${briefOf(problem, credentials)}); ` +
            'credentials are taken from the options and the environment alone',
          credentials,
        )
      }

      result = await run({
        messages: e.messages,
        instructions: e.instructions,
        config,
        credentials,
        ports: {
          fetch: (url, init) => $.http.fetch(url, init),
          pause: async (ms, signal) => {
            if (next.budget.remainingMs < ms + PAUSE_RESERVE_MS) {
              return false
            }

            await $.clock.sleep(ms, {
              signal: AbortSignal.any([next.signal, signal]),
            })

            return true
          },
          after: (ms, fn) => $.clock.after(ms, fn),
          signal: next.signal,
        },
      })
    } catch (error) {
      tell($, `built-in summary used instead: ${messageOf(error)}`, credentials)

      return next(e)
    }

    if (result.routing !== undefined) {
      log($, `provider decision: ${result.routing}`, credentials)
    }

    for (const line of decisionLinesOf(result.outcome.decisions)) {
      log($, line, credentials)
    }

    const reduction = reductionOf(result.outcome)

    if (reduction <= 0 || reduction < config.minReductionRatio) {
      tell(
        $,
        'built-in summary used instead: the reduction is below the ' +
          `${percentOf(config.minReductionRatio)} minimum (${summaryOf(result)})`,
        credentials,
      )

      return next(e)
    }

    tell(
      $,
      `compacted without a summary: ${result.outcome.messages.length} of ` +
        `${e.messages.length} messages remain (${summaryOf(result)})`,
      credentials,
    )

    return { messages: result.outcome.messages }
  })

  const arm = armOf()
  let isCompacting = false

  on('turn.complete', async ($, e, next) => {
    // A turn the person interrupted is not a moment to compact: they stopped
    // the session to say something, and a compaction would hold it paused.
    const isDue =
      config.compactAtPercent > 0 &&
      e.agentId === undefined &&
      !e.isAborted &&
      !isCompacting

    if (isDue) {
      isCompacting = true

      try {
        const { context } = await $.session.usage()

        if (isCompactionDue(arm, context.percent, config.compactAtPercent)) {
          await $.session.compact()

          settle(
            arm,
            (await $.session.usage()).context.percent,
            config.compactAtPercent,
          )
        }
      } catch (error) {
        // No credential is resolved on this path; the reason is the host's
        // own text, so it is still quoted short and held to the rule that
        // nothing after the word `Bearer` is shown.
        log(
          $,
          `compaction at ${config.compactAtPercent}% of the context was ` +
            `not run: ${briefOf(messageOf(error), {})}`,
          {},
        )
      } finally {
        isCompacting = false
      }
    }

    return next(e)
  })
}
