import { limitsOf } from '../hooks/providers'
import { isRecord } from '../hooks/systemone'

/**
 * One model OpenRouter lists with the `decisions` output modality, as its
 * listing states it.
 */
export type CatalogEntry = {
  id: string
  vendor: string
  /** Tokens; 0 where the listing states none. */
  contextLength: number
  /** USD per input token as the listing states it. */
  promptPricePerToken: number
}

/**
 * The day `OPENROUTER_CATALOG` was copied from OpenRouter's listing.
 */
export const CATALOG_FETCHED_AT = '2026-11-03'

/** The vendors the mod reaches directly; their OpenRouter models are not candidates here. */
export const DIRECT_VENDORS: readonly string[] = [
  'typesafe',
  'cloudflare',
  'perplexity',
  'openai',
  'codiv',
]

/**
 * The models OpenRouter lists with the `decisions` output modality whose
 * vendor the mod has no provider for, sorted by id as `openrouterOnlyOf`
 * sorts them. The `~` aliases are left out: each points at one of these,
 * and a run records the release an alias answers as instead.
 */
export const OPENROUTER_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'baseten/elephant-1',
    vendor: 'baseten',
    contextLength: 16_384,
    promptPricePerToken: 0.000000035,
  },
  {
    id: 'baseten/joey-1',
    vendor: 'baseten',
    contextLength: 16_384,
    promptPricePerToken: 0.00000001,
  },
  {
    id: 'baseten/mammoth-1',
    vendor: 'baseten',
    contextLength: 16_384,
    promptPricePerToken: 0.0000001,
  },
  {
    id: 'inception/mercury-decide',
    vendor: 'inception',
    contextLength: 65_536,
    promptPricePerToken: 0.00000002,
  },
  {
    id: 'jaredpalmer/kev-4b',
    vendor: 'jaredpalmer',
    contextLength: 8_192,
    promptPricePerToken: 0.000000042,
  },
  {
    id: 'liquid/d1',
    vendor: 'liquid',
    contextLength: 65_536,
    promptPricePerToken: 0.00000002,
  },
  {
    id: 'liquid/d1-ultra',
    vendor: 'liquid',
    contextLength: 32_768,
    promptPricePerToken: 0.000000042,
  },
  {
    id: 'liquid/d1.1',
    vendor: 'liquid',
    contextLength: 65_536,
    promptPricePerToken: 0.00000002,
  },
  {
    id: 'microsoft/microsoft-decision-1',
    vendor: 'microsoft',
    contextLength: 32_768,
    promptPricePerToken: 0.000000042,
  },
  {
    id: 'nace-ai/drex-max',
    vendor: 'nace-ai',
    contextLength: 262_144,
    promptPricePerToken: 0.00000006,
  },
  {
    id: 'nace-ai/drex-v1.5',
    vendor: 'nace-ai',
    contextLength: 131_072,
    promptPricePerToken: 0.00000004,
  },
  {
    id: 'nace-ai/drex-v2.0',
    vendor: 'nace-ai',
    contextLength: 131_072,
    promptPricePerToken: 0.00000006,
  },
  {
    id: 'respan/span-01',
    vendor: 'respan',
    contextLength: 0,
    promptPricePerToken: 0.00000002,
  },
  {
    id: 'respan/span-01-lite',
    vendor: 'respan',
    contextLength: 0,
    promptPricePerToken: 0,
  },
  {
    id: 'respan/span-01-lite:free',
    vendor: 'respan',
    contextLength: 0,
    promptPricePerToken: 0,
  },
  {
    id: 'respan/span-02',
    vendor: 'respan',
    contextLength: 131_072,
    promptPricePerToken: 0.00000001,
  },
  {
    id: 'scaledown/classify-1',
    vendor: 'scaledown',
    contextLength: 1_000_000,
    promptPricePerToken: 0.00000004,
  },
  {
    id: 'togethercomputer/tev1-4b-experimental',
    vendor: 'togethercomputer',
    contextLength: 32_768,
    promptPricePerToken: 0.000000042,
  },
  {
    id: 'upstage/solar-decide',
    vendor: 'upstage',
    contextLength: 524_288,
    promptPricePerToken: 0.00000005,
  },
  {
    id: 'upstage/solar-decide-flash',
    vendor: 'upstage',
    contextLength: 524_288,
    promptPricePerToken: 0.00000005,
  },
]

/**
 * The vendor of an OpenRouter model id: what comes before its `/`, with the
 * `~` that marks an alias left off. An id without a `/` is its own vendor.
 */
export function vendorOf(id: string): string {
  const bare = id.startsWith('~') ? id.slice(1) : id
  const slash = bare.indexOf('/')

  return slash === -1 ? bare : bare.slice(0, slash)
}

/**
 * The entry a listed model stands for, or undefined when it lacks a field
 * the entry needs or holds one no model can have: an id that is not blank,
 * its output modalities, a window that is a finite number of 0 or more,
 * and a prompt price that reads as a finite number of 0 or more. A blank id
 * would name no route, and a negative window or price would turn into a
 * budget or a spend figure that means nothing.
 */
function entryOf(model: unknown): CatalogEntry | undefined {
  if (
    !isRecord(model) ||
    typeof model.id !== 'string' ||
    model.id.trim() === ''
  ) {
    return undefined
  }

  const architecture = model.architecture
  const pricing = model.pricing

  if (
    !isRecord(architecture) ||
    !Array.isArray(architecture.output_modalities) ||
    !architecture.output_modalities.includes('decisions') ||
    typeof model.context_length !== 'number' ||
    !Number.isFinite(model.context_length) ||
    model.context_length < 0 ||
    !isRecord(pricing) ||
    typeof pricing.prompt !== 'string'
  ) {
    return undefined
  }

  // Number('') is 0, so an empty price would read as free.
  const price =
    pricing.prompt.trim() === '' ? Number.NaN : Number(pricing.prompt)

  if (!Number.isFinite(price) || price < 0) {
    return undefined
  }

  return {
    id: model.id,
    vendor: vendorOf(model.id),
    contextLength: model.context_length,
    promptPricePerToken: price,
  }
}

/**
 * The decision models of a fetched OpenRouter listing (the shape of
 * `GET /api/v1/models`) that only OpenRouter reaches: those whose output
 * modalities include `decisions`, less the models of `DIRECT_VENDORS` and
 * the `~` aliases. An entry missing a field it needs is skipped, not
 * refused, so one malformed model does not hide the rest.
 *
 * @param listing the parsed JSON of the listing
 * @returns the candidates, sorted by id
 */
export function openrouterOnlyOf(listing: unknown): CatalogEntry[] {
  if (!isRecord(listing) || !Array.isArray(listing.data)) {
    return []
  }

  const entries: CatalogEntry[] = []

  for (const model of listing.data as unknown[]) {
    const entry = entryOf(model)

    if (
      entry !== undefined &&
      !entry.id.startsWith('~') &&
      !DIRECT_VENDORS.includes(entry.vendor)
    ) {
      entries.push(entry)
    }
  }

  // A plain comparison, not localeCompare: the order must not depend on the
  // locale of the machine the bench runs on.
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The budgets a model whose window is smaller than the one the mod assumes
 * for it (`limitsOf` of the `openrouter` route, 32,000 tokens for a model
 * it does not know) needs, so that the state is cut by the mod before the
 * provider cuts it without saying so. A window the listing does not state
 * (0), or one at or above the assumed window, needs none: a budget cannot
 * raise the mod's own limit.
 */
export function budgetOverrideOf(
  entry: CatalogEntry,
): { maxStateTokens: number; maxRequestTokens: number } | undefined {
  const assumed = limitsOf({ provider: 'openrouter', model: entry.id })

  if (
    entry.contextLength <= 0 ||
    entry.contextLength >= assumed.maxStateTokens
  ) {
    return undefined
  }

  return {
    maxStateTokens: entry.contextLength,
    maxRequestTokens: entry.contextLength,
  }
}
