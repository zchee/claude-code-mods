import type { HttpResponse, PluginOptions } from 'claude-code'

import { decodeOpenAI, OPENAI } from './openai'
import { headOf } from './state'
import { BARE, bodyOf, bytesOf, idsOf, isRecord, replyOf } from './systemone'
import type { Question, Questions, Reply, Wire } from './systemone'

/**
 * The providers that serve the System One protocol, in the order the
 * manifest lists them. Of two gateways to the same model the one listed
 * first is the one the provider decision offers.
 */
export const PROVIDERS = [
  'typesafe',
  'cloudflare',
  'openrouter',
  'codiv',
  'perplexity',
  'decisions-api-dev',
  'decisionapi-net',
  'openai',
] as const

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
 * where no cap is documented. `maxRequestBytes` is a cap on the UTF-8 bytes
 * of the whole request body, for a provider that states its limit in bytes.
 */
export type Limits = {
  maxStateTokens: number
  maxRequestTokens: number
  maxQuestions?: number
  maxRequestBytes?: number
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
  codivApiKey?: string
  perplexityApiKey?: string
  decisionsApiKey?: string
  decisionapiApiKey?: string
  openaiApiKey?: string
}

/**
 * The environment variable each credential falls back to when its plugin
 * option is unset.
 */
const ENV_NAMES = {
  typesafeApiKey: 'TYPESAFE_API_KEY',
  openrouterApiKey: 'OPENROUTER_API_KEY',
  cloudflareApiToken: 'CLOUDFLARE_API_TOKEN',
  cloudflareAccountId: 'CLOUDFLARE_ACCOUNT_ID',
  codivApiKey: 'CODIV_API_KEY',
  perplexityApiKey: 'PERPLEXITY_API_KEY',
  decisionsApiKey: 'DECISIONS_API_KEY',
  decisionapiApiKey: 'DECISIONAPI_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
} as const satisfies Record<keyof Credentials, string>

type EnvName = (typeof ENV_NAMES)[keyof Credentials]

/**
 * The values of the credential variables as one source holds them.
 */
export type Environment = Partial<Record<EnvName, string | undefined>>

/**
 * One request as `$.http.fetch` takes it.
 */
type Exchange = {
  url: string
  init: { method: 'POST'; headers: Record<string, string>; body: string }
}

/**
 * Everything that differs between providers. The call path and the answer
 * validation are shared, so a provider is this record and nothing else.
 */
type Descriptor = {
  /**
   * The provider's name as a sentence about it spells it.
   */
  title: string
  defaultModel: string
  /**
   * The models the provider is offered with in the routing decision.
   */
  models: readonly string[]
  /**
   * The model family a model of this provider is, which is what two routes
   * are compared by: the same Jev is served directly and through gateways.
   */
  family: (model: string) => string
  /**
   * True for a provider that forwards to a model another provider hosts.
   */
  isGateway: boolean
  limits: Limits
  /**
   * True for a provider whose `usage.input_tokens` counts the state once
   * for every question of the request, so that what one reading of the
   * state took is the count divided by the questions asked.
   */
  countsStatePerQuestion?: true
  needs: readonly (keyof Credentials)[]
  bodyModelOf: (model: string) => string
  urlOf: (model: string, credentials: Credentials) => string
  tokenOf: (credentials: Credentials) => string | undefined
  wire: Wire
  /**
   * Takes the response out of whatever the provider wraps it in and into
   * the System One shape the readers of a reply take, given the questions
   * the request asked.
   */
  unwrap: (
    payload: unknown,
    credentials: Credentials,
    asked: Questions,
  ) => unknown
}

const CLOUDFLARE_MODELS = ['clef', 'clef-flash'] as const

/**
 * What a request to a provider that documents no limit is held to: the
 * tightest window and question cap among the documented ones (OpenRouter's
 * 32,000 tokens for Jev, Clef's 64 questions).
 */
const UNDOCUMENTED: Limits = {
  maxStateTokens: 32_000,
  maxRequestTokens: 32_000,
  maxQuestions: 64,
}

/**
 * How many questions one request to either Decisions reseller may hold.
 */
const RESELLER_QUESTIONS = 8

/**
 * The two Decisions resellers state their cap in bytes: the text and the
 * questions of a request within 32 KiB, and at most eight questions. Both
 * serve TypeSafe's Jev 1.13, so the token figures are the window TypeSafe
 * documents for it. They do not bind: 32 KiB of English is far fewer
 * tokens, and the state is fitted to the byte cap as well. They stand
 * against what the provider counts, so a reply that counts the whole window
 * is still read as a state that was cut short.
 */
const RESELLER: Limits = {
  maxStateTokens: 32_000,
  maxRequestTokens: 64_000,
  maxQuestions: RESELLER_QUESTIONS,
  maxRequestBytes: 32_768,
}

/**
 * The question ids decisions-api.dev accepts: a letter first, then letters,
 * digits, `_` or `-`, 64 characters at most. The mod's ids may hold `.` and
 * run to 100 characters, so the request names each question by its place
 * instead.
 */
const ALIAS_OF = (index: number) => `q${index}`

/**
 * The longest alias a request can carry: the one of the last place the
 * question cap allows. A question is measured under it, whatever its own
 * id, since the alias is what is sent.
 */
const LONGEST_ALIAS = ALIAS_OF(RESELLER_QUESTIONS - 1)

/**
 * The System One body with every question id replaced by its place in the
 * request, `q0`, `q1`, …. The ids are checked against the mod's own rule
 * first, as for every provider; option names inside a `choice` are left as
 * they are, since only question ids are restricted.
 */
const ALIASED: Wire = {
  encode: (model, state, questions) =>
    bodyOf(
      model,
      state,
      Object.fromEntries(
        idsOf(questions).map((id, index) => [
          ALIAS_OF(index),
          questions[id] as Question,
        ]),
      ),
    ),
  questionJsonOf: (_id, question) =>
    BARE.questionJsonOf(LONGEST_ALIAS, question),
  stateJsonOf: BARE.stateJsonOf,
  tokensPerQuestion: 0,
}

/**
 * A Jev id as TypeSafe names it: `jev`, `jev-latest`, `jev-1.13`.
 */
const JEV = /^jev(?:-|$)/

/**
 * The ids OpenRouter routes to Jev: a Jev id (`jev`, `jev-latest`,
 * `jev-1.13`) either bare, which OpenRouter maps onto TypeSafe's namespace
 * before routing, or under that namespace (`typesafe/`) or its alias
 * (`~typesafe/`). The namespace alone does not make a model Jev: any other
 * model TypeSafe publishes there is a model of its own.
 */
const OPENROUTER_JEV = /^(?:~?typesafe\/)?jev(?:-|$)/

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
const MIN_SECRET_CHARS = 8

/**
 * What stands where a credential was. It holds no part of what it replaces,
 * not even the word that announced it.
 */
const REDACTED = '[redacted]'

/**
 * An `Authorization` value as a response may echo it: the scheme and the
 * token after it, whoever's token that is. The two are separated by white
 * space in a header, and by a colon or an equals sign where the header was
 * written out as a field (`Bearer: ...`, `bearer=...`).
 */
const BEARER = /bearer(?:\s*[:=]\s*|\s+)[^\s"'<>]+/gi

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
 * The error for a response envelope that reports failure, quoting the
 * reason it gives.
 */
function envelopeFailure(
  reason: string | undefined,
  credentials: Credentials,
): Error {
  return new Error(
    'the response envelope reports failure: ' +
      briefOf(reason ?? '', credentials),
  )
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
    throw envelopeFailure(envelopeErrorOf(payload), credentials)
  }

  return isRecord(payload.result) ? payload.result : payload
}

/**
 * Takes a response out of the `{ code, message, data: { result } }` envelope
 * the two Decisions resellers answer with. A `code` other than 0, or no
 * `result`, is a failure, and the envelope's `message` is quoted as its
 * reason like any other text of a provider's: redacted and held to one
 * short line.
 */
function unwrapDataEnvelope(
  payload: unknown,
  credentials: Credentials,
): Record<string, unknown> {
  const data = isRecord(payload) ? payload.data : undefined
  const result = isRecord(data) ? data.result : undefined

  if (!isRecord(payload) || payload.code !== 0 || !isRecord(result)) {
    throw envelopeFailure(
      isRecord(payload) ? textOf(payload.message) : undefined,
      credentials,
    )
  }

  return result
}

/**
 * Reads a decisions-api.dev response: out of its envelope, and with every
 * answer back under the id of the question asked in that place. An answer
 * under a name that was not sent is refused: it answers nothing that was
 * asked. Both maps have no prototype, so an id or a name such as
 * `__proto__` is an ordinary key.
 */
function unwrapAliased(
  payload: unknown,
  credentials: Credentials,
  asked: Questions,
): unknown {
  const result = unwrapDataEnvelope(payload, credentials)

  if (!isRecord(result.answers)) {
    return result
  }

  const idOf: Record<string, string> = Object.create(null)
  const answers: Record<string, unknown> = Object.create(null)

  Object.keys(asked).forEach((id, index) => {
    idOf[ALIAS_OF(index)] = id
  })

  for (const [alias, answer] of Object.entries(result.answers)) {
    const id = Object.hasOwn(idOf, alias) ? idOf[alias] : undefined

    if (id === undefined) {
      throw new Error(
        `answered ${briefOf(alias, credentials)}, which was not asked`,
      )
    }

    answers[id] = answer
  }

  return { ...result, answers }
}

/**
 * A model name as configured, without the white space around it: how most
 * providers' bodies spell it.
 */
const TRIMMED = (model: string) => model.trim()

/**
 * A response that already is a bare System One reply.
 */
const AS_SENT = (payload: unknown) => payload

/**
 * The family of a model at a reseller of TypeSafe's Jev: Jev for a Jev id,
 * the model itself otherwise.
 */
const JEV_FAMILY = (model: string) => (JEV.test(model) ? 'jev' : model)

const TABLE: Record<ProviderName, Descriptor> = {
  typesafe: {
    title: 'TypeSafe',
    defaultModel: 'jev-latest',
    models: ['jev-latest'],
    family: () => 'jev',
    isGateway: false,
    limits: { maxStateTokens: 32_000, maxRequestTokens: 64_000 },
    needs: ['typesafeApiKey'],
    bodyModelOf: TRIMMED,
    urlOf: () => 'https://api.typesafe.ai/v1/systemone',
    tokenOf: credentials => credentials.typesafeApiKey,
    wire: BARE,
    unwrap: AS_SENT,
  },
  cloudflare: {
    title: 'Cloudflare',
    defaultModel: 'clef',
    models: CLOUDFLARE_MODELS,
    family: model => model,
    isGateway: false,
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
    wire: BARE,
    unwrap: unwrapCloudflare,
  },
  // OpenRouter documents Jev's window as 32,000 tokens for the state and the
  // questions together, which is tighter than TypeSafe's own 64,000 a request.
  // Its alias for the newest Jev is `~typesafe/jev-latest`. An id that has an
  // author prefix is sent on as written, so the same name without the `~` is
  // an id its documentation does not list.
  openrouter: {
    title: 'OpenRouter',
    defaultModel: '~typesafe/jev-latest',
    models: ['~typesafe/jev-latest'],
    family: model => (OPENROUTER_JEV.test(model) ? 'jev' : model),
    isGateway: true,
    limits: { maxStateTokens: 32_000, maxRequestTokens: 32_000 },
    needs: ['openrouterApiKey'],
    bodyModelOf: TRIMMED,
    urlOf: () => 'https://openrouter.ai/api/v1/systemone',
    tokenOf: credentials => credentials.openrouterApiKey,
    wire: BARE,
    unwrap: AS_SENT,
  },
  // Codiv serves its own open Jev, which answers as `openjev-0.1` and is a
  // model of its own, not TypeSafe's Jev; at Codiv `jev-latest` is an alias
  // of it. Its window is 65,536 tokens for the state and the questions
  // together, and it advises about 60,000 for the state. It documents no
  // fixed question cap and answered 129 questions in one request.
  codiv: {
    title: 'Codiv',
    defaultModel: 'openjev-latest',
    models: ['openjev-latest'],
    family: model => (/^(?:open)?jev(?:-|$)/.test(model) ? 'openjev' : model),
    isGateway: false,
    limits: { maxStateTokens: 60_000, maxRequestTokens: 65_536 },
    needs: ['codivApiKey'],
    bodyModelOf: TRIMMED,
    urlOf: () => 'https://api.codiv.ai/v1/systemone',
    tokenOf: credentials => credentials.codivApiKey,
    wire: BARE,
    unwrap: AS_SENT,
  },
  // Perplexity refuses any model but its own deciders (HTTP 400, "Invalid
  // model"), Jev included. A request must stay under 262,144 input tokens,
  // the state and every question counted, and holds 1 to 128 questions.
  // Its `usage.input_tokens` counts the state again for every question: on
  // 2026-10-11 the same state cost 108, 216 and 864 tokens with 1, 2 and 8
  // questions, and 8 questions reported as 312,744 tokens were answered.
  perplexity: {
    title: 'Perplexity',
    defaultModel: 'pplx-decider-v1.1-27b',
    models: ['pplx-decider-v1.1-27b'],
    family: model =>
      /^pplx-decider(?:-|$)/.test(model) ? 'pplx-decider' : model,
    isGateway: false,
    limits: {
      maxStateTokens: 262_143,
      maxRequestTokens: 262_143,
      maxQuestions: 128,
    },
    countsStatePerQuestion: true,
    needs: ['perplexityApiKey'],
    bodyModelOf: TRIMMED,
    urlOf: () => 'https://api.perplexity.ai/v1/decisions',
    tokenOf: credentials => credentials.perplexityApiKey,
    wire: BARE,
    unwrap: AS_SENT,
  },
  // The two Decisions resellers forward to TypeSafe's Jev and wrap the
  // reply in an envelope of their own. decisions-api.dev alone restricts
  // question ids, so its requests name questions by their place.
  'decisions-api-dev': {
    title: 'decisions-api.dev',
    defaultModel: 'jev-latest',
    models: ['jev-latest'],
    family: JEV_FAMILY,
    isGateway: true,
    limits: RESELLER,
    needs: ['decisionsApiKey'],
    bodyModelOf: TRIMMED,
    urlOf: () => 'https://decisions-api.dev/v1/systemone',
    tokenOf: credentials => credentials.decisionsApiKey,
    wire: ALIASED,
    unwrap: unwrapAliased,
  },
  // decisionapi.net states its 32 KiB body limit only where it describes
  // image input; it is the platform's one stated body limit, so text is
  // held to it as well.
  'decisionapi-net': {
    title: 'decisionapi.net',
    defaultModel: 'jev-latest',
    models: ['jev-latest'],
    family: JEV_FAMILY,
    isGateway: true,
    limits: RESELLER,
    needs: ['decisionapiApiKey'],
    bodyModelOf: TRIMMED,
    urlOf: () => 'https://decisionapi.net/v1/systemone',
    tokenOf: credentials => credentials.decisionapiApiKey,
    wire: BARE,
    unwrap: unwrapDataEnvelope,
  },
  // OpenAI takes the same questions in a body of its own shape and answers
  // in a list. Its Decisions API documents no limits, so it is held to the
  // fallback. Those figures are this mod's, not a window OpenAI states: a
  // reply counting all of them is taken as a cut state although the model
  // may have read it whole, which errs toward the built-in summary.
  openai: {
    title: 'OpenAI',
    defaultModel: 'gpt-6-luna',
    models: ['gpt-6-luna'],
    family: model => model,
    isGateway: false,
    limits: UNDOCUMENTED,
    needs: ['openaiApiKey'],
    bodyModelOf: TRIMMED,
    urlOf: () => 'https://api.openai.com/v1/decisions',
    tokenOf: credentials => credentials.openaiApiKey,
    wire: OPENAI,
    unwrap: (payload, _credentials, asked) => decodeOpenAI(payload, asked),
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

  if (route.provider === 'openrouter' && !OPENROUTER_JEV.test(route.model)) {
    return {
      ...limits,
      maxQuestions: TABLE.cloudflare.limits.maxQuestions,
    }
  }

  return limits
}

/**
 * The models a provider is offered with in the routing decision.
 *
 * @param provider the provider
 * @returns the model names as its body spells them
 */
export function modelsOf(provider: ProviderName): readonly string[] {
  return TABLE[provider].models
}

/**
 * The model family a route reaches: a gateway's route to Jev is the same
 * Jev that TypeSafe serves directly.
 *
 * @param route the route
 * @returns the family, the model name itself for a model of its own
 */
export function familyOf(route: Route): string {
  return TABLE[route.provider].family(route.model)
}

/**
 * Names a gateway as a sentence about it spells the name.
 *
 * @param provider the provider
 * @returns the name, or undefined for a provider that hosts its models
 */
export function gatewayOf(provider: ProviderName): string | undefined {
  const described = TABLE[provider]

  return described.isGateway ? described.title : undefined
}

/**
 * The UTF-8 bytes a request over a route takes besides its questions: the
 * body as encoded around one question, less that question as the route's
 * wire format measures it. The model name and the state are counted
 * exactly as they are sent. What is left holds no bracket of the question
 * map or list; each question is measured with brackets of its own and a
 * comma after it, so a body counted this way is over by a few bytes a
 * question, never under.
 *
 * @param route the route
 * @param state what the questions are asked about
 * @returns the byte count
 */
export function bytesBesideOf(route: Route, state: unknown): number {
  const described = TABLE[route.provider]
  const question: Question = { type: 'noul', instructions: '' }
  const body = described.wire.encode(
    described.bodyModelOf(route.model),
    state,
    { q: question },
  )

  return bytesOf(body) - bytesOf(described.wire.questionJsonOf('q', question))
}

/**
 * How a request over a route is written, which is also how its size is
 * estimated.
 *
 * @param route the route
 * @returns the provider's wire format
 */
export function wireOf(route: Route): Wire {
  return TABLE[route.provider].wire
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
 * Keeps only the credentials the given providers need. A credential of a
 * provider that may not be called is dropped here, so no later step can
 * send anything with it.
 *
 * @param providers the providers a compaction may call
 * @param credentials what was resolved
 * @returns the credentials of those providers
 */
export function credentialsFor(
  providers: readonly ProviderName[],
  credentials: Credentials,
): Credentials {
  const needed = new Set(providers.flatMap(provider => TABLE[provider].needs))
  const kept: Credentials = {}

  for (const key of needed) {
    const value = credentials[key]

    if (value !== undefined) {
      kept[key] = value
    }
  }

  return kept
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
 * The C0 and C1 control characters: a terminal acts on them rather than
 * showing them, so a quoted text could move the cursor or recolour what
 * follows it.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * A text this mod did not write, made fit to quote in a message: redacted,
 * on one line, with no control character, and no longer than
 * `REASON_CHARS`.
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
  const line = redacted(text, credentials)
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return line === '' ? 'no reason given' : cutOf(line)
}

/**
 * A text held to `REASON_CHARS`: cut there, never between the two halves of
 * a surrogate pair, with `…` where it was cut.
 *
 * @param text the text
 * @returns the text, or its first `REASON_CHARS` characters and `…`
 */
export function cutOf(text: string): string {
  return text.length > REASON_CHARS ? `${headOf(text, REASON_CHARS)}…` : text
}

/**
 * The message of a thrown value, which need not be an `Error`.
 *
 * @param error what was thrown
 * @returns its message, or the value as text
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
      body: described.wire.encode(model, state, questions),
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
 * the providers use: `error.message`, `errors[0].message`, a bare
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
 * The field errors of a validation failure, as `field: message` sentences:
 * the `error.details.fieldErrors` map Workers AI answers a body it refuses
 * with, which names what was wrong where the reason only says that it was.
 */
function fieldErrorsIn(payload: unknown): string | undefined {
  const error = isRecord(payload) ? payload.error : undefined
  const details = isRecord(error) ? error.details : undefined
  const fields = isRecord(details) ? details.fieldErrors : undefined

  if (!isRecord(fields)) {
    return undefined
  }

  const sentences = Object.entries(fields).flatMap(([field, messages]) =>
    Array.isArray(messages)
      ? messages.filter(m => typeof m === 'string').map(m => `${field}: ${m}`)
      : [],
  )

  return sentences.length > 0 ? sentences.join('; ') : undefined
}

/**
 * How deep a reason is followed into the bodies quoted inside it.
 */
const REASON_DEPTH = 4

/**
 * A reason with the bodies it quotes unwrapped. A gateway passes on the
 * failure of the host it forwarded to as text: OpenRouter's reason is
 * `HTTP 422: ` and the host's body, whose own reason is `AiError: AiError: `
 * and another body. Only the innermost sentence says what was refused, and
 * it would not fit a toast line behind the wrappers, so every `HTTP nnn:`
 * and `AiError:` prefix is dropped and a quoted body is read for its own
 * reason and field errors.
 */
function innermostReason(reason: string, depth: number): string {
  const bare = reason.replace(/^(?:\s*(?:HTTP \d{3}|AiError):)+\s*/i, '')
  const start = bare.indexOf('{')
  const end = bare.lastIndexOf('}')

  if (depth >= REASON_DEPTH || start !== 0 || end < start) {
    return bare
  }

  let quoted: unknown

  try {
    quoted = JSON.parse(bare.slice(start, end + 1))
  } catch {
    return bare
  }

  return statedIn(quoted, depth + 1) ?? bare
}

/**
 * What an error body states: its reason with the bodies quoted in it
 * unwrapped, and its field errors after it, or either alone.
 */
function statedIn(payload: unknown, depth: number): string | undefined {
  const reason = reasonIn(payload)
  const fields = fieldErrorsIn(payload)

  return reason === undefined
    ? fields
    : fields === undefined
      ? innermostReason(reason, depth)
      : `${innermostReason(reason, depth)}: ${fields}`
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

  return briefOf(statedIn(payload, 0) ?? text, credentials)
}

/**
 * Turns a provider's HTTP response into a reply, or throws saying why not: a
 * failed status with the provider's own reason, a body that is not JSON, an
 * envelope reporting failure, a body without answers, or a count
 * of input tokens that shows the request was not read whole.
 *
 * Every message that quotes the response is redacted here, where it is
 * built, so no caller can show one that is not.
 *
 * @param route the route the request went over
 * @param response what `$.http.fetch` resolved with
 * @param credentials the resolved credentials, to keep out of the messages
 * @param asked the questions the request asked, for a provider whose answers
 * name them otherwise
 * @returns the reply
 */
export function replyFrom(
  route: Route,
  response: HttpResponse,
  credentials: Credentials,
  asked: Questions,
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
    reply = replyOf(TABLE[route.provider].unwrap(payload, credentials, asked))
  } catch (error) {
    throw new Error(
      `${route.provider}: ${briefOf(messageOf(error), credentials)}`,
    )
  }

  // The size of a request is only estimated here, and a provider may cut a
  // state that is too long without saying so. A count that is at the limit
  // is what a request cut to the limit reports, and answers about a state
  // the model saw part of are no ground for removing anything. A provider
  // that counts the state once a question is held to what one reading took.
  const { limits, countsStatePerQuestion } = TABLE[route.provider]
  const { maxRequestTokens } = limits
  const counted =
    reply.usage.input_tokens === undefined || !countsStatePerQuestion
      ? reply.usage.input_tokens
      : Math.ceil(
          reply.usage.input_tokens / Math.max(Object.keys(asked).length, 1),
        )

  if (counted !== undefined && counted >= maxRequestTokens) {
    throw new Error(
      `${route.provider} counted ${counted} input tokens` +
        `${countsStatePerQuestion ? ' a question' : ''}, all that a ` +
        `request of its may hold (${maxRequestTokens}): the state was ` +
        'probably cut short, so the answers decide nothing',
    )
  }

  return reply
}
