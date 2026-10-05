import type { PluginOptions } from 'claude-code'

import { providerOf, PROVIDERS, REASON_CHARS } from './providers'
import type { ProviderName } from './providers'
import { headOf } from './state'

/**
 * The plugin's options as the hooks use them: every value present, typed
 * and inside the range it is meaningful in.
 */
export type Config = {
  provider: ProviderName
  /**
   * Why no compaction may be decided with these options, when there is such
   * a reason. It is set for an option that says where the conversation is
   * sent and cannot be read: a destination is never guessed.
   */
  refusal?: string
  /**
   * The model name for the configured provider; absent for its default.
   */
  model?: string
  providerDecision: boolean
  keepThreshold: number
  preserveRecentMessages: number
  compactAtPercent: number
  minReductionRatio: number
  maxStateTokens: number
  maxRequestTokens: number
  truncateHeadChars: number
}

/**
 * What an option reads as when it is unset or unusable; the manifest's
 * `userConfig` states the same values to the person.
 */
export const DEFAULTS = {
  provider: 'typesafe',
  providerDecision: false,
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
} as const satisfies Config

/**
 * A numeric option held to a range. A value that is not a finite number
 * reads as the default; one outside the range is moved to its nearest end.
 */
function within(
  value: unknown,
  fallback: number,
  low: number,
  high: number,
): number {
  const number =
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

  return Math.min(high, Math.max(low, number))
}

/**
 * Says whether an option was left unset: absent, or text with nothing in
 * it, which is what a cleared field holds.
 */
function isUnset(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  )
}

/**
 * Reads the plugin's options. Nothing here throws, because this runs while
 * the module loads and a throw would take both hooks with it: an option the
 * person mistyped reads as its default.
 *
 * The one exception is `provider`, which decides who is sent the
 * conversation. Only an unset `provider` reads as the default. A value that
 * names none of the providers is not replaced by one the person did not
 * choose: it is reported in `refusal`, and every compaction is then left to
 * the built-in summary.
 *
 * @param options what `register` received
 * @returns the configuration
 */
export function configOf(options: PluginOptions): Config {
  const named = providerOf(options.provider)
  const config: Config = {
    provider: named ?? DEFAULTS.provider,
    providerDecision: options.providerDecision === true,
    keepThreshold: within(options.keepThreshold, DEFAULTS.keepThreshold, 0, 1),
    preserveRecentMessages: Math.floor(
      within(
        options.preserveRecentMessages,
        DEFAULTS.preserveRecentMessages,
        0,
        Infinity,
      ),
    ),
    compactAtPercent: within(
      options.compactAtPercent,
      DEFAULTS.compactAtPercent,
      0,
      100,
    ),
    minReductionRatio: within(
      options.minReductionRatio,
      DEFAULTS.minReductionRatio,
      0,
      1,
    ),
    maxStateTokens: Math.floor(
      within(options.maxStateTokens, DEFAULTS.maxStateTokens, 1, Infinity),
    ),
    maxRequestTokens: Math.floor(
      within(options.maxRequestTokens, DEFAULTS.maxRequestTokens, 1, Infinity),
    ),
    truncateHeadChars: Math.floor(
      within(
        options.truncateHeadChars,
        DEFAULTS.truncateHeadChars,
        0,
        Infinity,
      ),
    ),
  }

  if (named === undefined && !isUnset(options.provider)) {
    const given = JSON.stringify(options.provider)

    config.refusal =
      'the provider option is ' +
      (given.length > REASON_CHARS
        ? `${headOf(given, REASON_CHARS)}…`
        : given) +
      `, which is none of ${PROVIDERS.join(', ')}`
  }

  if (typeof options.model === 'string' && options.model.trim() !== '') {
    config.model = options.model.trim()
  }

  return config
}
