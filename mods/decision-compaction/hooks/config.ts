import type { PluginOptions } from 'claude-code'

import { cutOf, providerOf, PROVIDERS } from './providers'
import type { ProviderName } from './providers'

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
  /**
   * The providers the provider decision may pick besides the configured
   * one, in `PROVIDERS` order.
   */
  decisionProviders: readonly ProviderName[]
  /**
   * The names in `decisionProviders` that are no provider, as given; absent
   * when there are none. They are dropped, not refused: leaving a name out
   * can only narrow where the conversation is sent.
   */
  unknownProviders?: string[]
  keepThreshold: number
  preserveRecentMessages: number
  compactAtPercent: number
  minReductionRatio: number
  /**
   * The state budget the person set; absent for the one each route asks
   * for (`wantedOf`).
   */
  maxStateTokens?: number
  /**
   * The request budget the person set; absent for the one each route asks
   * for (`wantedOf`).
   */
  maxRequestTokens?: number
  truncateHeadChars: number
}

/**
 * What an option reads as when it is unset or unusable; the manifest's
 * `userConfig` states the same values to the person. The two budgets have
 * none here: each route has its own (`wantedOf`), and the manifest states
 * no default for them, so that one never set stays absent.
 */
const DEFAULTS = {
  provider: 'typesafe',
  providerDecision: false,
  decisionProviders: PROVIDERS,
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  compactAtPercent: 60,
  minReductionRatio: 0.25,
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
 * Reads the `decisionProviders` option: a list, or the names in one text
 * separated by commas. Unset, it is every provider. The host fills in the
 * manifest's default for a field that was never set, so an empty text is a
 * field the person cleared, and like an empty list it names no provider:
 * only the configured one is then eligible. Names are matched as `provider`
 * is, exactly; a value of any other type names no provider.
 */
function decisionProvidersOf(value: unknown): {
  named: readonly ProviderName[]
  unknown: string[]
} {
  if (value === undefined || value === null) {
    return { named: DEFAULTS.decisionProviders, unknown: [] }
  }

  const given = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [value]
  const names = given
    .map(name =>
      typeof name === 'string' ? name.trim() : String(JSON.stringify(name)),
    )
    .filter(name => name !== '')

  return {
    named: PROVIDERS.filter(provider => names.includes(provider)),
    unknown: [...new Set(names.filter(name => providerOf(name) === undefined))],
  }
}

/**
 * The providers a compaction may send anything to: the configured one, and
 * with the provider decision on also those `decisionProviders` names, in
 * `PROVIDERS` order. Everything that reads a credential or offers a route
 * goes by this one list.
 *
 * @param config the configuration
 * @returns the providers
 */
export function eligibleOf(config: Config): ProviderName[] {
  return PROVIDERS.filter(
    provider =>
      provider === config.provider ||
      (config.providerDecision && config.decisionProviders.includes(provider)),
  )
}

/**
 * A budget option: a whole number of tokens from 1 up, or absent when it is
 * unset or not a number, so that the route's own budget stands.
 */
function budgetOptionOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : undefined
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
  const deciding = decisionProvidersOf(options.decisionProviders)
  const config: Config = {
    provider: named ?? DEFAULTS.provider,
    providerDecision: options.providerDecision === true,
    decisionProviders: deciding.named,
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
    config.refusal =
      `the provider option is ${cutOf(JSON.stringify(options.provider))}, ` +
      `which is none of ${PROVIDERS.join(', ')}`
  }

  if (deciding.unknown.length > 0) {
    config.unknownProviders = deciding.unknown
  }

  if (typeof options.model === 'string' && options.model.trim() !== '') {
    config.model = options.model.trim()
  }

  const maxStateTokens = budgetOptionOf(options.maxStateTokens)
  const maxRequestTokens = budgetOptionOf(options.maxRequestTokens)

  if (maxStateTokens !== undefined) {
    config.maxStateTokens = maxStateTokens
  }

  if (maxRequestTokens !== undefined) {
    config.maxRequestTokens = maxRequestTokens
  }

  return config
}
