import type { SessionMessage } from 'claude-code'

import type { Ask } from './compact'
import {
  briefOf,
  familyOf,
  gatewayOf,
  missingOf,
  modelsOf,
} from './providers'
import type { Credentials, ProviderName, Route } from './providers'
import type { Call } from './state'
import { choiceOf } from './systemone'
import type { ChoiceQuestion } from './systemone'

/**
 * A route the decision may pick: the name it is offered under and what is
 * documented about the model behind it.
 */
export type Candidate = {
  key: string
  route: Route
  about: string
}

/**
 * The job in a few numbers: what the routing question is asked about. It
 * stands in for the full state, which would cost a second full-size request
 * just to choose where to send the first.
 */
export type Profile = {
  context: string
  goal: string
  messages: number
  candidate_calls: number
  state_tokens: number
  tools: Record<string, number>
  error_share: number
  non_ascii_share: number
}

/**
 * Says why the fitted state and its questions do not fit a route's limits,
 * or nothing when they do.
 */
export type SizeCheck = (route: Route) => string | undefined

/**
 * The route to use and one line saying how it was arrived at.
 */
export type Routed = {
  route: Route
  why: string
}

/**
 * The id of the one routing question.
 */
export const ROUTE_QUESTION = 'route'

/**
 * How many tools the profile names; the rest are counted together.
 */
const TOOLS_SHOWN = 8

/**
 * What the providers' own documentation says each model is for. The
 * decision is only as good as these lines, so each states published facts
 * and nothing inferred.
 */
const ABOUT: Record<string, string> = {
  clef:
    'Clef, a 27B model. Cloudflare recommends it for highest-precision ' +
    'decisions. It is slower and costs more per token than Clef-flash.',
  'clef-flash':
    'Clef-flash, a 9B model. Cloudflare recommends it for latency-critical ' +
    'decisions on a hot path. It is the fastest of the models offered here.',
  jev:
    "Jev, TypeSafe's flagship System One model. It reads text only, and " +
    'English is its primary training language: TypeSafe reports lower ' +
    'accuracy on other languages, CJK scripts included.',
  openjev:
    'OpenJev, DiffusionGemma 26B-A4B made into a System One model; it ' +
    'reads a distribution for every answer in one denoising step.',
  'pplx-decider':
    "Perplexity's 27B decision model. It reads text and images and " +
    'returns typed answers with probabilities.',
  'gpt-6-luna':
    'GPT-6 Luna, which OpenAI describes as its most efficient model for ' +
    'focused, high-volume tasks, served through its Decisions API.',
}

const PROFILE_CONTEXT =
  'A coding assistant session is about to be compacted: a decision model ' +
  'will be asked, for each old tool call, whether the call and its output ' +
  'still have to stay in the transcript. This object describes that job: ' +
  'how many messages and candidate tool calls there are, the estimated ' +
  'size in tokens of the state every request will carry, which tools were ' +
  'called how often, the share of calls that ended in an error, and the ' +
  'share of the conversation text that is not ASCII. `goal` is what the ' +
  'assistant is working on.'

/**
 * A route as a line of text shows it.
 *
 * @param route the route
 * @returns `provider/model`
 */
export function labelOf(route: Route): string {
  return `${route.provider}/${route.model}`
}

function keyOf(route: Route): string {
  return `${route.provider}.${route.model.replace(/[^A-Za-z0-9_.-]/g, '-')}`
}

function aboutOf(route: Route): string {
  const known = ABOUT[familyOf(route)]
  const gateway = gatewayOf(route.provider)
  const via = gateway === undefined ? '' : ` Reached through ${gateway}.`

  return known === undefined
    ? `The model ${route.model} at ${route.provider}; nothing is documented ` +
        'here about what it is best at.'
    : `${known}${via}`
}

/**
 * Says why a route cannot take the job, or nothing when it can. Both checks
 * are ones code can make with certainty, which is why they are made here
 * and not put to a model.
 */
function refusalOf(
  route: Route,
  credentials: Credentials,
  sizeRefusalOf: SizeCheck,
): string | undefined {
  const missing = missingOf(route.provider, credentials)

  return missing.length > 0
    ? `${missing.join(' and ')} unset`
    : sizeRefusalOf(route)
}

/**
 * Lists the routes that can take the job.
 *
 * Every eligible provider is considered with each model it offers; the
 * configured provider with the configured model in place of its default. A
 * route is left out when a credential it needs is unset or the fitted state
 * exceeds its documented limit. A model family is offered once: over the
 * route that reaches it directly whenever there is one, else over the
 * first gateway to it in `PROVIDERS` order, and every other route to it is
 * left out of the choice.
 *
 * @param configured the route the options name
 * @param eligible the providers that may be sent anything, in `PROVIDERS`
 * order
 * @param credentials the resolved credentials
 * @param sizeRefusalOf the check of the fitted state against a route's limits
 * @returns the candidates, for every route not offered the reason, and
 * whether the configured provider is among the routes that can take the job
 */
export function candidatesOf(
  configured: Route,
  eligible: readonly ProviderName[],
  credentials: Credentials,
  sizeRefusalOf: SizeCheck,
): { candidates: Candidate[]; refused: string[]; isConfiguredUsable: boolean } {
  const usable: Route[] = []
  const refused: string[] = []

  for (const provider of eligible) {
    const offered = modelsOf(provider)
    const models =
      provider === configured.provider && !offered.includes(configured.model)
        ? [configured.model]
        : offered

    for (const model of models) {
      const route = { provider, model }
      const refusal = refusalOf(route, credentials, sizeRefusalOf)

      if (refusal === undefined) {
        usable.push(route)
      } else {
        refused.push(`${labelOf(route)}: ${refusal}`)
      }
    }
  }

  const offered = new Map<string, Route>()

  for (const route of [
    ...usable.filter(route => gatewayOf(route.provider) === undefined),
    ...usable.filter(route => gatewayOf(route.provider) !== undefined),
  ]) {
    if (!offered.has(familyOf(route))) {
      offered.set(familyOf(route), route)
    }
  }

  const candidates: Candidate[] = []

  for (const route of usable) {
    const same = offered.get(familyOf(route))

    if (same !== undefined && same !== route) {
      refused.push(`${labelOf(route)}: the same model as ${labelOf(same)}`)
      continue
    }

    candidates.push({ key: keyOf(route), route, about: aboutOf(route) })
  }

  return {
    candidates,
    refused,
    isConfiguredUsable: usable.some(
      route => route.provider === configured.provider,
    ),
  }
}

function shareOf(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100) / 100
}

/**
 * Describes the job for the routing question.
 *
 * @param messages the conversation
 * @param calls the calls that will be asked about
 * @param stateTokens the estimated size of the fitted state
 * @param goal what the assistant is working on
 * @returns the profile
 */
export function profileOf(
  messages: readonly SessionMessage[],
  calls: readonly Call[],
  stateTokens: number,
  goal: string,
): Profile {
  const counts = new Map<string, number>()

  for (const call of calls) {
    counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1)
  }

  const ranked = [...counts].sort(([, a], [, b]) => b - a)
  const tools = Object.fromEntries(ranked.slice(0, TOOLS_SHOWN))
  const rest = ranked
    .slice(TOOLS_SHOWN)
    .reduce((sum, [, count]) => sum + count, 0)

  if (rest > 0) {
    tools.other = rest
  }

  let chars = 0
  let nonAscii = 0

  for (const { text } of messages) {
    chars += text.length

    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) > 127) {
        nonAscii++
      }
    }
  }

  return {
    context: PROFILE_CONTEXT,
    goal,
    messages: messages.length,
    candidate_calls: calls.length,
    state_tokens: stateTokens,
    tools,
    error_share: shareOf(
      calls.filter(call => call.isError).length,
      calls.length,
    ),
    non_ascii_share: shareOf(nonAscii, chars),
  }
}

/**
 * The one question the decision asks: which of the candidates should judge
 * this job, each described by what is documented about it.
 *
 * @param candidates the routes on offer, two or more
 * @returns the `choice` question
 */
export function routeQuestionOf(
  candidates: readonly Candidate[],
): ChoiceQuestion {
  return {
    type: 'choice',
    instructions:
      'Which decision model should judge this compaction job? A wrong ' +
      '"remove" loses output the assistant may still need, a wrong "keep" ' +
      'only wastes context, and the answers are waited for while the ' +
      'session is paused. Pick the model whose documented strengths fit ' +
      'the job the state describes.',
    criteria: Object.fromEntries(
      candidates.map(candidate => [candidate.key, candidate.about]),
    ),
  }
}

/**
 * Decides which route a compaction goes over.
 *
 * First by what code can check: `candidatesOf` leaves out every route that
 * cannot take the job. Only when two or more remain is a model asked, with
 * one `choice` question over the job's profile, on the fastest route there
 * is: Cloudflare's Clef-flash when Cloudflare is eligible and configured,
 * the configured route otherwise. The question carries a profile with the
 * person's prompts in it, so it goes to no provider outside the eligible
 * ones. With one candidate or a failed routing request the
 * configured route is used, so the decision can never make a compaction
 * fail that would have worked without it; the exception is a configured
 * route that cannot take the job at all, where the one that can is used.
 * The one candidate may be the direct route to the model a configured
 * gateway also reaches: there is then one model and nothing to choose, and
 * the configured gateway stays in use.
 *
 * With no candidate at all there is nothing to send the job to, the
 * configured route included, so this throws, and the reason lists why each
 * route was ruled out: the person has to see which credential or limit to
 * change.
 *
 * @param configured the route the options name
 * @param eligible the providers that may be sent anything, in `PROVIDERS`
 * order
 * @param credentials the resolved credentials
 * @param sizeRefusalOf the check of the fitted state against a route's limits
 * @param profile the job's profile
 * @param askOn how a question is sent over a given route
 * @returns the route and why it was picked; throws when no route can take
 * the job
 */
export async function chooseRoute(
  configured: Route,
  eligible: readonly ProviderName[],
  credentials: Credentials,
  sizeRefusalOf: SizeCheck,
  profile: Profile,
  askOn: (route: Route) => Ask,
): Promise<Routed> {
  const { candidates, refused, isConfiguredUsable } = candidatesOf(
    configured,
    eligible,
    credentials,
    sizeRefusalOf,
  )
  const [first, second] = candidates
  const left = refused.length === 0 ? '' : ` (${refused.join('; ')})`

  if (first === undefined) {
    throw new Error(`no route can take this job: ${refused.join('; ')}`)
  }

  if (second === undefined) {
    if (!isConfiguredUsable) {
      return {
        route: first.route,
        why: `only ${labelOf(first.route)} can take this job${left}`,
      }
    }

    const found =
      first.route.provider === configured.provider
        ? 'one route is available'
        : 'one model is available'

    return {
      route: configured,
      why: `${found}${left}; using the configured ${labelOf(configured)}`,
    }
  }

  const asked: Route =
    eligible.includes('cloudflare') &&
    missingOf('cloudflare', credentials).length === 0
      ? { provider: 'cloudflare', model: 'clef-flash' }
      : configured

  try {
    const reply = await askOn(asked)(profile, {
      [ROUTE_QUESTION]: routeQuestionOf(candidates),
    })
    const picked = choiceOf(
      reply,
      ROUTE_QUESTION,
      candidates.map(candidate => candidate.key),
    )
    const chosen = candidates.find(candidate => candidate.key === picked.choice)

    if (chosen === undefined) {
      throw new Error('the picked option is not a candidate')
    }

    const sure =
      picked.confidence === undefined
        ? ''
        : `, confidence ${picked.confidence.toFixed(2)}`

    return {
      route: chosen.route,
      why: `${labelOf(asked)} picked ${labelOf(chosen.route)}${sure}`,
    }
  } catch (error) {
    // The reason may quote a provider's text, and it reaches the report
    // line, so it is quoted like any other: redacted and on one short line.
    const reason = briefOf(
      error instanceof Error ? error.message : String(error),
      credentials,
    )

    return {
      route: configured,
      why:
        `the routing request failed (${reason}); using the configured ` +
        labelOf(configured),
    }
  }
}
