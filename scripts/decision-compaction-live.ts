// Sends one synthetic decision request to every decision-compaction provider
// whose credentials are set in the environment, through the mod's own request
// builder and reply parser, and prints one verdict line per provider.
//
// Usage: bun scripts/decision-compaction-live.ts
// Exit status: 1 when any provider that was called failed, 0 otherwise.
import type { HttpResponse } from 'claude-code'

import {
  credentialsFor,
  credentialsOf,
  ENV_NAMES,
  exchangeOf,
  missingOf,
  PROVIDERS,
  redacted,
  replyFrom,
  routeOf,
} from '../mods/decision-compaction/hooks/providers'
import type {
  Credentials,
  Environment,
  ProviderName,
} from '../mods/decision-compaction/hooks/providers'
import { choiceOf, noulOf } from '../mods/decision-compaction/hooks/systemone'
import type { Questions } from '../mods/decision-compaction/hooks/systemone'

const TIMEOUT_MS = 30_000

// A made-up exchange: nothing from a real conversation is ever sent.
const STATE = {
  conversation: [
    { role: 'user', text: 'What will the weather be in Tokyo tomorrow?' },
    {
      role: 'assistant',
      text: 'Tomorrow in Tokyo it will be sunny with a high of 24°C.',
    },
  ],
}

// Ids that every provider accepts, decisions-api.dev's stricter rule included.
const NOUL_ID = 'asks_weather'
const CHOICE_ID = 'topic'
const OPTIONS = ['weather', 'cooking', 'code'] as const
const QUESTIONS: Questions = {
  [NOUL_ID]: {
    type: 'noul',
    instructions: 'Does the user ask about the weather?',
  },
  [CHOICE_ID]: {
    type: 'choice',
    instructions: 'What is the conversation about?',
    criteria: {
      weather: 'The weather or a forecast',
      cooking: 'Food or recipes',
      code: 'Programming',
    },
  },
}

type Verdict = { line: string; failed: boolean }

function environmentFromProcess(): Environment {
  const environment: Environment = {}

  for (const name of Object.values(ENV_NAMES)) {
    environment[name] = process.env[name]
  }

  return environment
}

async function probe(
  provider: ProviderName,
  credentials: Credentials,
): Promise<Verdict> {
  const missing = missingOf(provider, credentials)

  if (missing.length > 0) {
    return {
      line: `skip ${provider}: ${missing.join(' and ')} unset`,
      failed: false,
    }
  }

  const route = routeOf(provider)

  try {
    // Only this provider's own credential goes into its request.
    const exchange = exchangeOf(
      route,
      credentialsFor([provider], credentials),
      STATE,
      QUESTIONS,
    )
    const fetched = await fetch(exchange.url, {
      ...exchange.init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const response: HttpResponse = {
      status: fetched.status,
      ok: fetched.ok,
      headers: Object.fromEntries(fetched.headers),
      text: await fetched.text(),
    }
    const reply = replyFrom(route, response, credentials, QUESTIONS)
    const noul = noulOf(reply, NOUL_ID)
    const picked = choiceOf(reply, CHOICE_ID, OPTIONS)
    const confidence =
      picked.confidence === undefined
        ? ''
        : ` confidence=${picked.confidence.toFixed(3)}`
    const answeredAs =
      reply.model !== undefined && reply.model !== route.model
        ? ` (answered as ${reply.model})`
        : ''

    return {
      line:
        `ok ${provider}/${route.model} noul=${noul.toFixed(3)} ` +
        `choice=${picked.choice}${confidence}${answeredAs}`,
      failed: false,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    return {
      line: `FAIL ${provider}: ${reason.replace(/\s+/g, ' ').trim()}`,
      failed: true,
    }
  }
}

const credentials = credentialsOf({}, environmentFromProcess())
const verdicts = await Promise.all(
  PROVIDERS.map(provider => probe(provider, credentials)),
)

for (const verdict of verdicts) {
  // Every printed line passes through the mod's redaction with every resolved
  // credential, whatever produced it.
  console.log(redacted(verdict.line, credentials))
}

if (verdicts.some(verdict => verdict.failed)) {
  process.exit(1)
}
