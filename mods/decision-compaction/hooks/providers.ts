import type { HttpResponse, PluginOptions } from 'claude-code'

import { headOf } from './state'
import { bodyOf, replyOf } from './systemone'
import type { Questions, Reply } from './systemone'

/**
 * The providers that serve the System One protocol, in the order the
 * manifest lists them.
 */
export const PROVIDERS = ['typesafe', 'cloudflare', 'openrouter'] as const

export type ProviderName = (typeof PROVIDERS)[number]

/**
 * One way to reach one model: the provider that is called and the model name
 * as that provider's request body spells it.
 */
export type Route = {
  provider: ProviderName
  model: string
}

/**
 * What a provider's documentation says a request may hold, in tokens as the
 * provider counts them.
 *
 * `maxStateTokens` bounds the state together with the longest single
 * question, which is how TypeSafe states its limit; `maxQuestions` is absent
 * where no cap is documented.
 */
export type Limits = {
  maxStateTokens: number
  maxRequestTokens: number
  maxQuestions?: number
}

/**
 * The secrets and the account id the providers need, each present only when
 * one was configured.
 */
export type Credentials = {
  typesafeApiKey?: string
  openrouterApiKey?: string
  cloudflareApiToken?: string
  cloudflareAccountId?: string
}

/**
 * The environment variable each credential falls back to when its plugin
 * option is unset.
 */
export const ENV_NAMES = {
  typesafeApiKey: 'TYPESAFE_API_KEY',
  openrouterApiKey: 'OPENROUTER_API_KEY',
  cloudflareApiToken: 'CLOUDFLARE_API_TOKEN',
  cloudflareAccountId: 'CLOUDFLARE_ACCOUNT_ID',
} as const satisfies Record<keyof Credentials, string>

export type EnvName = (typeof ENV_NAMES)[keyof Credentials]

/**
 * The values of the credential variables as one source holds them.
 */
export type Environment = Partial<Record<EnvName, string | undefined>>

/**
 * One request as `$.http.fetch` takes it.
 */
export type Exchange = {
  url: string
  init: { method: 'POST'; headers: Record<string, string>; body: string }
}

/**
 * Everything that differs between providers. The request body and the answer
 * validation are shared, so a provider is this record and nothing else.
 */
type Descriptor = {
  defaultModel: string
  limits: Limits
  needs: readonly (keyof Credentials)[]
  bodyModelOf: (model: string) => string
  urlOf: (model: string, credentials: Credentials) => string
  tokenOf: (credentials: Credentials) => string | undefined
  unwrap: (payload: unknown, credentials: Credentials) => unknown
}

const CLOUDFLARE_MODELS = ['clef', 'clef-flash'] as const

/**
 * The Workers AI catalogue prefix; a Cloudflare model is `clef` in the body
 * and this prefix plus `clef` in the URL.
 */
const CLOUDFLARE_PREFIX = '@cf/cloudflare/'

/**
 * How much is quoted of a text this mod did not write (an error body, a
 * failure envelope, the host's reason for refusing a call): enough to read
 * the reason, short enough for one toast line.
 */
export const REASON_CHARS = 160

/**
 * The shortest value treated as a secret when a text is redacted. A shorter
 * one is not a key any of the providers issues, and replacing it wherever
 * its few characters occur would garble the ordinary words around it.
 */
export const MIN_SECRET_CHARS = 8

/**
 * What stands where a credential was. It holds no part of what it replaces,
 * not even the word that announced it.
 */
export const REDACTED = '[redacted]'

/**
 * An `Authorization` value as a response may echo it: the scheme and the
 * token after it, whoever's token that is. The two are separated by white
 * space in a header, and by a colon or an equals sign where the header was
 * written out as a field (`Bearer: ...`, `bearer=...`).
 */
const BEARER = /bearer(?:\s*[:=]\s*|\s+)[^\s"'<>]+/gi

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined
}

/**
 * Accepts a Cloudflare model by its short name or its catalogue id, and
 * answers the short name. The body's `model` must be `clef` or `clef-flash`,
 * so any other name is refused here rather than by a 4xx after the state was
 * sent.
 */
function cloudflareModelOf(model: string): string {
  const named = model.trim()
  const short = named.startsWith(CLOUDFLARE_PREFIX)
    ? named.slice(CLOUDFLARE_PREFIX.length)
    : named

  if (!CLOUDFLARE_MODELS.some(known => known === short)) {
    throw new Error(
      `cloudflare serves ${CLOUDFLARE_MODELS.join(' and ')}, not ` +
        JSON.stringify(named),
    )
  }

  return short
}

/**
 * The first message of a Workers AI envelope's `errors` list.
 */
function envelopeErrorOf(payload: Record<string, unknown>): string | undefined {
  const first = Array.isArray(payload.errors) ? payload.errors[0] : undefined

  return isRecord(first) ? textOf(first.message) : undefined
}

/**
 * Takes a Workers AI response out of its `{ result, success, errors }`
 * envelope. A body that is already a bare reply is passed through, because
 * the envelope is documented for the REST API in general and not for Clef.
 * The reason a failed envelope gives is quoted like any other text of a
 * provider's: redacted and held to one short line.
 */
function unwrapCloudflare(payload: unknown, credentials: Credentials): unknown {
  if (!isRecord(payload)) {
    return payload
  }

  if (payload.success === false) {
    throw new Error(
      'the response envelope reports failure: ' +
        briefOf(envelopeErrorOf(payload) ?? '', credentials),
    )
  }

  return isRecord(payload.result) ? payload.result : payload
}

const TABLE: Record<ProviderName, Descriptor> = {
  typesafe: {
    defaultModel: 'jev-latest',
    limits: { maxStateTokens: 32_000, maxRequestTokens: 64_000 },
    needs: ['typesafeApiKey'],
    bodyModelOf: model => model.trim(),
    urlOf: () => 'https://api.typesafe.ai/v1/systemone',
    tokenOf: credentials => credentials.typesafeApiKey,
    unwrap: payload => payload,
  },
  cloudflare: {
    defaultModel: 'clef',
    limits: {
      maxStateTokens: 65_536,
      maxRequestTokens: 65_536,
      maxQuestions: 64,
    },
    needs: ['cloudflareApiToken', 'cloudflareAccountId'],
    bodyModelOf: cloudflareModelOf,
    urlOf: (model, credentials) =>
      'https://api.cloudflare.com/client/v4/accounts/' +
      `${encodeURIComponent(credentials.cloudflareAccountId ?? '')}/ai/run/` +
      `${CLOUDFLARE_PREFIX}${model}`,
    tokenOf: credentials => credentials.cloudflareApiToken,
    unwrap: unwrapCloudflare,
  },
  // OpenRouter documents Jev's window as 32,000 tokens for the state and the
  // questions together, which is tighter than TypeSafe's own 64,000 a request.
  // Its alias for the newest Jev is `~typesafe/jev-latest`. An id that has an
  // author prefix is sent on as written, so the same name without the `~` is
  // an id its documentation does not list.
  openrouter: {
    defaultModel: '~typesafe/jev-latest',
    limits: { maxStateTokens: 32_000, maxRequestTokens: 32_000 },
    needs: ['openrouterApiKey'],
    bodyModelOf: model => model.trim(),
    urlOf: () => 'https://openrouter.ai/api/v1/systemone',
    tokenOf: credentials => credentials.openrouterApiKey,
    unwrap: payload => payload,
  },
}

/**
 * Narrows a configured value to a provider name.
 *
 * @param value the value of the `provider` option
 * @returns the provider, or undefined when the value names none
 */
export function providerOf(value: unknown): ProviderName | undefined {
  return PROVIDERS.find(name => name === value)
}

/**
 * The ids OpenRouter routes to Jev: a Jev id (`jev`, `jev-latest`,
 * `jev-1.13`) either bare, which OpenRouter maps onto TypeSafe's namespace
 * before routing, or under that namespace (`typesafe/`) or its alias
 * (`~typesafe/`). The namespace alone does not make a model Jev: any other
 * model TypeSafe publishes there is a model of its own.
 */
const OPENROUTER_JEV = /^(?:~?typesafe\/)?jev(?:-|$)/

/**
 * Tells whether an OpenRouter model id reaches Jev.
 *
 * @param model the model id as OpenRouter's body spells it
 * @returns true for a Jev id
 */
export function isOpenRouterJev(model: string): boolean {
  return OPENROUTER_JEV.test(model)
}

/**
 * The limits a request over a route must keep to. OpenRouter is a gateway:
 * a request it forwards is also held to what the model's own host accepts.
 * Its Jev window is documented, and no question cap with it. Any other model
 * it serves is held to Cloudflare's 64 questions as well, because Clef, the
 * one other System One model, is served there and refuses a request with
 * more (HTTP 422, "Dictionary should have at most 64 items").
 *
 * @param route the provider and the model
 * @returns its limits
 */
export function limitsOf(route: Route): Limits {
  const limits = TABLE[route.provider].limits

  if (route.provider === 'openrouter' && !isOpenRouterJev(route.model)) {
    return {
      ...limits,
      maxQuestions: TABLE.cloudflare.limits.maxQuestions,
    }
  }

  return limits
}

/**
 * The models a provider offers the routing decision: both Cloudflare models,
 * and for a single-model provider its default.
 *
 * @param provider the provider
 * @returns the model names as its body spells them
 */
export function modelsOf(provider: ProviderName): readonly string[] {
  return provider === 'cloudflare'
    ? CLOUDFLARE_MODELS
    : [TABLE[provider].defaultModel]
}

/**
 * Builds the route for a provider: the configured model when one is set, the
 * provider's default otherwise, spelled as the provider's body expects it.
 *
 * @param provider the provider
 * @param model the configured model name, when one is set
 * @returns the route; throws when the provider does not serve the model
 */
export function routeOf(provider: ProviderName, model?: string): Route {
  const described = TABLE[provider]

  return {
    provider,
    model: described.bodyModelOf(textOf(model) ?? described.defaultModel),
  }
}

/**
 * Names the environment variables of the credentials a provider needs and
 * does not have. The names are safe to show; the values never are.
 *
 * @param provider the provider
 * @param credentials what was resolved
 * @returns the variable names, empty when the provider can be called
 */
export function missingOf(
  provider: ProviderName,
  credentials: Credentials,
): EnvName[] {
  return TABLE[provider].needs
    .filter(need => credentials[need] === undefined)
    .map(need => ENV_NAMES[need])
}

/**
 * Throws when a provider lacks a credential it needs, naming the variable
 * to set. Checked before any work is done for a request that could not be
 * sent.
 *
 * @param provider the provider
 * @param credentials what was resolved
 */
export function assertConfigured(
  provider: ProviderName,
  credentials: Credentials,
): void {
  const missing = missingOf(provider, credentials)

  if (missing.length > 0) {
    throw new Error(
      `${provider} is not configured: ${missing.join(' and ')} is unset`,
    )
  }
}

/**
 * Names the credential variables that still have no value after the plugin
 * options and one source of the environment were read, among those the given
 * providers need. An empty answer means a further source would add nothing,
 * so it need not be read.
 *
 * @param providers the providers a compaction may call
 * @param options the plugin's options
 * @param read the variables as that source holds them
 * @returns the variable names, each once
 */
export function unresolvedOf(
  providers: readonly ProviderName[],
  options: PluginOptions,
  read: Environment,
): EnvName[] {
  const credentials = credentialsOf(options, read)

  return [
    ...new Set(providers.flatMap(provider => missingOf(provider, credentials))),
  ]
}

/**
 * Lays one source of the credential variables under another: a value the
 * first source holds wins, and the `env` block of the settings fills the
 * rest. The block is read as untyped data, since settings are a plain object.
 *
 * @param read the variables as the process environment holds them
 * @param settingsEnv the `env` key of the merged settings
 * @returns the variables with every gap the settings can fill filled
 */
export function environmentOf(
  read: Environment,
  settingsEnv: unknown,
): Environment {
  const fallback = isRecord(settingsEnv) ? settingsEnv : {}
  const merged: Environment = {}

  for (const name of Object.values(ENV_NAMES)) {
    merged[name] = textOf(read[name]) ?? textOf(fallback[name])
  }

  return merged
}

/**
 * Resolves each credential: the plugin option when it is set, the
 * environment otherwise.
 *
 * @param options the plugin's options
 * @param environment the credential variables, already merged over settings
 * @returns the credentials that have a value
 */
export function credentialsOf(
  options: PluginOptions,
  environment: Environment,
): Credentials {
  const credentials: Credentials = {}

  for (const [key, name] of Object.entries(ENV_NAMES)) {
    const value = textOf(options[key]) ?? textOf(environment[name])

    if (value !== undefined) {
      credentials[key as keyof Credentials] = value
    }
  }

  return credentials
}

/**
 * Takes every credential out of a text that is about to be shown.
 *
 * A provider's error body is quoted to the person, and a body may repeat
 * what the request carried: the key itself, or the whole `Authorization`
 * header. Each secret that was resolved is replaced wherever it stands, the
 * longest first so that one secret containing another leaves no remainder,
 * and then anything that follows the word `Bearer`, which covers a token
 * this mod never held. A resolved value under `MIN_SECRET_CHARS` is not
 * replaced by value; the `Bearer` rule still covers it where it follows
 * that word. The account id is not a secret and is left alone.
 *
 * @param text the text
 * @param credentials the resolved credentials
 * @returns the text with `REDACTED` where a credential stood
 */
export function redacted(text: string, credentials: Credentials): string {
  const secrets = PROVIDERS.map(provider =>
    TABLE[provider].tokenOf(credentials),
  )
    .filter(
      (secret): secret is string =>
        secret !== undefined && secret.length >= MIN_SECRET_CHARS,
    )
    .sort((a, b) => b.length - a.length)
  let shown = text

  for (const secret of secrets) {
    shown = shown.split(secret).join(REDACTED)
  }

  return shown.replace(BEARER, REDACTED)
}

/**
 * A text this mod did not write, made fit to quote in a message: redacted,
 * on one line, and no longer than `REASON_CHARS`.
 *
 * The text is redacted before it is shortened: a cut that fell inside a
 * credential would leave a part of it that no longer matches the whole. The
 * cut never falls between the two halves of a surrogate pair.
 *
 * @param text what a provider or the host said
 * @param credentials the resolved credentials
 * @returns the line to quote; `no reason given` for a text that says nothing
 */
export function briefOf(text: string, credentials: Credentials): string {
  const line = redacted(text, credentials).replace(/\s+/g, ' ').trim()

  if (line === '') {
    return 'no reason given'
  }

  return line.length > REASON_CHARS ? `${headOf(line, REASON_CHARS)}…` : line
}

/**
 * Builds the request for one batch of questions. The credential goes into
 * the `authorization` header and nowhere else, so nothing built from the
 * returned URL or body can leak it.
 *
 * @param route which provider and model
 * @param credentials the resolved credentials
 * @param state what the questions are asked about
 * @param questions the questions, by id
 * @returns the URL and the init for `$.http.fetch`; throws when a credential
 * the provider needs is missing, naming its environment variable
 */
export function exchangeOf(
  route: Route,
  credentials: Credentials,
  state: unknown,
  questions: Questions,
): Exchange {
  assertConfigured(route.provider, credentials)

  const described = TABLE[route.provider]
  const token = described.tokenOf(credentials) ?? ''
  const model = described.bodyModelOf(route.model)

  return {
    url: described.urlOf(model, credentials),
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: bodyOf(model, state, questions),
    },
  }
}

/**
 * Says whether a status is worth another attempt: rate limiting, an
 * overloaded provider and any server-side failure. A 4xx other than 429 is
 * the request's own fault and would fail the same way again.
 *
 * @param status the HTTP status
 * @returns true when a retry may succeed
 */
export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * Finds the sentence an error body gives as its reason, across the shapes
 * the three providers use: `error.message`, `errors[0].message`, a bare
 * `error`, `message` or `detail` string.
 */
function reasonIn(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const nested = isRecord(payload.error)
    ? textOf(payload.error.message)
    : undefined

  return (
    nested ??
    envelopeErrorOf(payload) ??
    textOf(payload.error) ??
    textOf(payload.message) ??
    textOf(payload.detail)
  )
}

/**
 * The reason a failed response gives, as one short line. The response body
 * is the only source: the sentence it names as its reason when it is JSON
 * of a known shape, the body itself otherwise.
 */
function reasonOf(text: string, credentials: Credentials): string {
  let payload: unknown

  try {
    payload = JSON.parse(text)
  } catch {
    payload = undefined
  }

  return briefOf(reasonIn(payload) ?? text, credentials)
}

/**
 * Turns a provider's HTTP response into a reply, or throws saying why not: a
 * failed status with the provider's own reason, a body that is not JSON, a
 * Cloudflare envelope reporting failure, a body without answers, or a count
 * of input tokens that shows the request was not read whole.
 *
 * Every message that quotes the response is redacted here, where it is
 * built, so no caller can show one that is not.
 *
 * @param route the route the request went over
 * @param response what `$.http.fetch` resolved with
 * @param credentials the resolved credentials, to keep out of the messages
 * @returns the reply
 */
export function replyFrom(
  route: Route,
  response: HttpResponse,
  credentials: Credentials,
): Reply {
  if (!response.ok) {
    throw new Error(
      `${route.provider} answered HTTP ${response.status}: ` +
        reasonOf(response.text, credentials),
    )
  }

  let payload: unknown

  try {
    payload = JSON.parse(response.text)
  } catch {
    throw new Error(`${route.provider} answered a body that is not JSON`)
  }

  let reply: Reply

  try {
    reply = replyOf(TABLE[route.provider].unwrap(payload, credentials))
  } catch (error) {
    throw new Error(
      redacted(
        `${route.provider}: ${error instanceof Error ? error.message : String(error)}`,
        credentials,
      ),
    )
  }

  // The size of a request is only estimated here, and a provider may cut a
  // state that is too long without saying so. A count that is at the limit
  // is what a request cut to the limit reports, and answers about a state
  // the model saw part of are no ground for removing anything.
  const counted = reply.usage.input_tokens
  const { maxRequestTokens } = TABLE[route.provider].limits

  if (counted !== undefined && counted >= maxRequestTokens) {
    throw new Error(
      `${route.provider} counted ${counted} input tokens, all that a ` +
        `request of its may hold (${maxRequestTokens}): the state was ` +
        'probably cut short, so the answers decide nothing',
    )
  }

  return reply
}
