# decision-compaction

A Claude Code mod for `session.compact`. Instead of a written summary, the
conversation comes back as it was, with only those tool calls and tool
outputs removed that a System One decision model says the assistant can do
without. What you and the assistant wrote stays word for word.

**The conversation text and the tool inputs are sent to the selected
third-party API** (TypeSafe, Cloudflare or OpenRouter) on every compaction.
They are sent as they are: a secret you pasted into a prompt, or one that
appears in a tool input such as a shell command, goes with them. Tool
outputs are not sent: each is replaced by a note of its status and length.
**With `providerDecision` on, a second provider can receive data in the
same compaction**: the routing question, when there is a choice to make,
goes to Cloudflare whenever Cloudflare credentials are set, whichever
provider is configured, and it carries a profile of the job that includes
up to 2,000 characters of your prompts (the text typed after `/compact`, or
your last three prompts). Do not enable this mod for a session whose
content must not leave your machine.

## What it does

On `session.compact` (a `/compact`, the engine's own threshold, or this
mod's trigger) the hook:

1. Matches each tool call to its output by `tool_use_id`. The first message
   is never changed, and neither is any of the last
   `preserveRecentMessages`; a call that sits in one of those, or whose
   output does, is not judged. A
   `tool_use_id` that occurs on more than one call or output is not judged
   either, since a decision is applied by that id.
2. Describes the whole conversation in one state and shrinks it only as far
   as its budget requires. The reductions are tried in a fixed order and
   the first that is enough ends the search: shorter tool inputs, the
   middle cut out of long texts (old messages before the protected ones),
   old texts replaced by their length, old calls written on one line, old
   messages without a call omitted, and neighbouring old messages that
   hold nothing but calls merged into one entry. Sizes are estimates; no tokenizer is used.
3. Puts two yes/no questions to the provider for every call left to judge:
   is the call itself still needed, and is its complete output still
   needed word for word. A request holds as many of these questions as the
   token budget and the provider's own limit on questions allow, and each
   request carries the full state. See [Limits](#limits) for the bounds.
4. Compares each answer with `keepThreshold`. Either the call and its
   output both stay; or the call stays and the output is shortened to its
   opening `truncateHeadChars` characters, followed by a note saying how
   much was removed; or the call goes and its output goes with it. Output
   so short that shortening would save nothing is not touched.
5. Hands back the new list of messages. A message nothing touched goes
   back exactly as the engine gave it, and an output never outlives its
   call.

A message that had one of its blocks dropped or cut is rebuilt from its
role, its text and its remaining tool blocks, and nothing else survives the
rebuild. Two consequences: a result that is kept, but shares its message
with a result that was dropped or cut, loses any image content it had; and
an assistant message that made several calls, one of which was dropped,
loses its thinking block.

It fails open. On any error (a missing key, a `provider` option that names
no provider, an HTTP error, a request that is rejected, a compaction whose
requests are not answered in time, a malformed answer, a conversation that
cannot be fitted or would take too many requests) and when the decisions
would remove less than `minReductionRatio`, it says why in one line and
lets the built-in summary run. A `precompute` compaction is always left to
the engine.

Every request that asks about a tool call goes to one provider: the
configured one, or the one the provider decision picked. Nothing falls over
to another provider. With `providerDecision` on there can be one more
request before them, the routing question, and it may go to a different
provider (see below).

On `turn.complete`, when the main conversation's context reaches
`compactAtPercent`, the mod requests a compaction. What happens next
depends on the usage that compaction leaves:

- Under the threshold: the next time usage reaches the threshold, another
  compaction is requested at once.
- At or above the threshold: that level becomes a floor, and no further
  compaction is requested until usage has risen ten points above it. A
  floor above 90% cannot be risen from, so after a compaction that leaves
  usage there, no automatic compaction is requested again until usage has
  first dropped under the threshold (for example after a `/compact` of your
  own or a `/clear`).
- Unknown: usage is not known right after a compaction (it arrives with the
  next response). The first later reading at or above the threshold then
  becomes the floor, and the next request waits for a rise of ten points
  above that reading.

A turn you interrupted, and a subagent's turn, request nothing.

## Providers

| `provider` | Model by default | Credentials | Documented limits |
| --- | --- | --- | --- |
| `typesafe` (default) | `jev-latest` | `TYPESAFE_API_KEY` | 64,000 tokens a request; 32,000 for the state plus the longest question |
| `cloudflare` | `clef` (`clef-flash` is the other) | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` | 65,536 tokens; 64 questions a request |
| `openrouter` | `~typesafe/jev-latest` | `OPENROUTER_API_KEY` | 32,000 tokens for the state plus the questions; 64 questions a request for any model other than Jev |

The `provider` option takes exactly these three names. Any other value is
not replaced by the default: nothing is sent anywhere, and every compaction
uses the built-in summary with a line naming the value. Only an option left
unset or empty means `typesafe`. For that reason `/config` shows the option
as a text field rather than a list (a list would let the engine turn an
unknown value into the default without saying so).

`~typesafe/jev-latest` is OpenRouter's alias for the newest Jev;
`typesafe/jev-1.13` pins a release. OpenRouter also takes TypeSafe's bare
ids and maps them itself (`jev-latest` to `~typesafe/jev-latest`,
`jev-1.13` to `typesafe/jev-1.13`). An id that already has an author prefix
is used as written.

OpenRouter also serves Cloudflare's Clef (`cloudflare/clef`,
`cloudflare/clef-flash`), and passes such a request on to Cloudflare, which
refuses one with more than 64 questions. A model other than Jev on
`openrouter` is therefore asked at most 64 questions (32 tool calls) a
request, as on `cloudflare`, while the token limits stay OpenRouter's.

Each credential is read from its plugin option first, then from the
environment, at the time of the compaction. The `env` block of the settings
is read only when a credential a provider in play needs is still missing;
if the settings cannot be read, that is logged and the compaction goes on
with what it has.

Text that comes from a provider or from the host (an HTTP error body, a
Cloudflare failure envelope, the reason the host gives for refusing a
request or a read) is quoted in the toast and the log on one line of at
most 160 characters. Before it is shown, every credential this mod resolved
is replaced with `[redacted]`, and so is the token after the word `Bearer`,
whether it follows a space, a colon or an equals sign. A resolved value
shorter than eight characters is not replaced where it stands on its own,
since no provider issues a key that short and replacing it would garble
ordinary words.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `provider` | `typesafe` | Which provider decides; any other name sends nothing. |
| `model` | provider default | Model name for the configured provider. |
| `providerDecision` | `false` | Decide the provider per compaction; see below. |
| `typesafeApiKey` | unset | TypeSafe API key (stored as a secret). |
| `openrouterApiKey` | unset | OpenRouter API key (stored as a secret). |
| `cloudflareApiToken` | unset | Cloudflare API token allowed to run Workers AI (stored as a secret). |
| `cloudflareAccountId` | unset | Cloudflare account ID. |
| `keepThreshold` | `0.5` | Probability from which a call, or its full result, is kept. |
| `preserveRecentMessages` | `6` | Newest messages that are never changed. |
| `compactAtPercent` | `60` | Context usage at which a compaction is requested; `0` turns the trigger off. |
| `minReductionRatio` | `0.25` | Smallest share of characters the decisions must remove. |
| `maxStateTokens` | `25000` | Most estimated tokens the state may take, a whole number; see [Limits](#limits). |
| `maxRequestTokens` | `30000` | Most estimated tokens one request may take, state and questions together, a whole number; see [Limits](#limits). |
| `truncateHeadChars` | `300` | Characters kept of a shortened output; at `0` only the note remains. |

## Limits

The bounds below are fixed; they are not options.

- **Margin under the documented limits.** The token estimate is made
  without a tokenizer and its weights were fitted to Jev, and Cloudflare
  cuts a state that is too long without saying so. A budget is therefore
  held to 85% of the provider's documented limit: 27,200 tokens for the
  state plus the longest question and 54,400 a request on `typesafe`,
  55,705 on `cloudflare`, 27,200 on `openrouter`. On `openrouter` that is
  below the default `maxRequestTokens` of 30,000, so the default is lowered
  there.
- **A reply that shows a cut.** If a provider reports as many input tokens
  as its documented request limit, the state was probably cut short. The
  answers are discarded and the built-in summary runs.
- **Room for a batch.** The state may take at most the request budget less
  the questions of 16 tool calls (of all of them, when there are fewer).
  Every request carries the whole state, so without this a state that
  filled the request would be sent once per call.
- **At most 16 requests** ask about tool calls in one compaction, three at
  a time. A conversation that would need a 17th is left to the built-in
  summary, and the line says how many it would have taken. The routing
  question of `providerDecision` is one request more.
- **Retries.** A 429 or a 5xx is retried after 0.4 s and again after 1.2 s;
  nothing else is. A retry is skipped when the hook has too little of its
  ten seconds left to wait and still finish (the wait plus 1.5 s); the last
  429 or 5xx then decides, as a failure.
- **One failure ends the compaction.** Once a request about tool calls has
  failed for good (an answer that is not retried, or the last retry), no
  request is sent and no retry is waited for after it, by any batch; the
  requests still out are abandoned. A failed routing question is the one
  exception: the configured provider then decides, as described below.
- **30 seconds for the whole compaction.** One deadline covers everything a
  compaction sends: the routing question, every batch, every retry and the
  waits before retries. It starts when the first request can go out. When
  it passes, every request still out is abandoned, nothing further is
  sent, and the built-in summary runs; that is the longest the session
  stays paused waiting on the providers. A request cannot be withdrawn, so
  a late answer is ignored.

### How large a conversation can be decided

At the default budgets the state holds about 25,000 estimated tokens after
every reduction, and 16 requests ask about a bounded number of calls. Past
either bound the result is always the built-in summary.

The table is a measurement, not a guarantee. It was taken with a fake
provider on a synthetic session made only of `Read` calls with short file
paths and 600-character outputs, between one opening and one closing
prompt. A real session has longer inputs, more varied tools and more text,
so its limits are lower, and differ from one session to the next; read the
numbers as rough orders of size.

| `provider` | Calls whose assistant message also carries a sentence of text | Call-only messages |
| --- | --- | --- |
| `typesafe` | roughly 400 (then the state no longer fits) | roughly 900 (then a 17th request) |
| `cloudflare` | roughly 400 (then the state no longer fits) | 512 (32 calls a request) |
| `openrouter` | roughly 290 (then a 17th request) | roughly 820 (then a 17th request) |

Longer tool inputs and longer tool names lower these numbers. Raising
`maxStateTokens` and `maxRequestTokens` raises them, up to the margins
above.

## `providerDecision`

Off by default: the configured provider is always used.

When on, the mod first drops every route it can rule out in code: a provider
whose credentials are unset, whose limits the fitted state exceeds, or that
would need more than 16 requests. Cloudflare contributes two routes (`clef`
and `clef-flash`); an OpenRouter id that names Jev (`jev`, `jev-…`, alone
or under `typesafe/` or `~typesafe/`) is not offered when TypeSafe is
usable, since it is the same model through a gateway. Any other OpenRouter
id, under `typesafe/` included, is a model of its own. If two or more
routes remain, one `choice` question is asked over a small profile of the
job (message and call counts, state size, tool mix, error share, share of
non-ASCII text, and the goal), not over the conversation. The goal is your
own text: what you typed after `/compact`, cut to 2,000 characters, or your
last three prompts, cut to 500 characters each. The question is asked on
Cloudflare `clef-flash` when Cloudflare is configured, otherwise on the
configured provider. The option descriptions state only what the providers
document about their models.

With one route left, or when the routing request fails, the configured
provider is used and the reason is logged. That includes the case where the
configured provider is OpenRouter and the one route left is TypeSafe's
direct route to the same model. The one exception: if the configured
provider cannot take the job and exactly one other route can, that route is
used. With no route left at all the built-in summary runs, and its line
lists every route with the reason it was ruled out. A routing question
still unanswered when the compaction's 30 seconds run out does not hand
the job to the configured provider: the built-in summary runs.

## Loading

```sh
claude --plugin-dir mods/decision-compaction
```

Options are read from settings under `pluginConfigs` and appear in
`/config`. A mod loaded with `--plugin-dir` is keyed
`decision-compaction@inline` (the bare `decision-compaction` is read too);
an installed one is keyed by its plugin id, `decision-compaction@<marketplace>`.

Each compaction ends with one line, in a toast and in the log, for example
`compacted without a summary: 41 of 96 messages remain (...)`, with what
happened to the tool calls, the provider and model used, the estimated size
of the state, and the input tokens the provider counted. A `per-call
verdicts:` line lists both probabilities for every call asked about.

## Development

```sh
claude plugin validate mods/decision-compaction
claude plugin test mods/decision-compaction
```

The tests use a fake provider at the `$.http.fetch` seam and never reach a
network.

A hot reload of the mod while a compaction is running cancels the mod's
pending waits, the deadline's timer among them, so that compaction's
30-second bound does not hold across the reload. This matters only while
the mod is being developed.

## Credit

The algorithm follows the design of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT); the code here is an independent implementation.
