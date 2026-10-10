# decision-compaction

Compaction without a summary. A Claude Code mod for `session.compact` that
hands the conversation back as it was, with only those tool calls and tool
outputs removed that a System One decision model says the assistant can do
without. What you and the assistant wrote stays word for word.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)
[![Plugin API: Claude Code 2.1.292](https://img.shields.io/badge/plugin%20API-Claude%20Code%202.1.292-8A2BE2.svg)](../types/claude-code/index.d.ts)
[![Providers: 8](https://img.shields.io/badge/providers-8-success.svg)](#providers)

> [!WARNING]
> **The conversation text and the tool inputs are sent to the selected
> third-party API** (TypeSafe, Cloudflare, OpenRouter, Codiv, Perplexity,
> decisions-api.dev, decisionapi.net or OpenAI) on every compaction.
> They are sent as they are: a secret you pasted into a prompt, or one that
> appears in a tool input such as a shell command, goes with them. Tool
> outputs are not sent: each is replaced by a note of its status and length.
>
> **With `providerDecision` on, a second provider can receive data in the
> same compaction.** Every provider in `decisionProviders` (all eight by
> default) whose credentials resolve is a candidate to decide it, so a key
> you exported for another tool, `OPENAI_API_KEY` for example, makes that
> vendor eligible to receive the conversation. `decisionProviders` is the
> setting that narrows the set. The routing question, when there is a
> choice to make, goes to Cloudflare only when `cloudflare` is one of the
> providers considered (the configured provider, and those in
> `decisionProviders`) and its credentials are set; otherwise it goes to the
> configured provider. It carries a profile of the job that includes up to
> 2,000 characters of your prompts (the text typed after `/compact`, or
> your last three prompts).
>
> Do not enable this mod for a session whose content must not leave your
> machine.

## Table of contents

- [Install](#install)
- [How it works](#how-it-works)
  - [On `session.compact`](#on-sessioncompact)
  - [On `turn.complete`](#on-turncomplete)
- [Providers](#providers)
  - [Credentials](#credentials)
  - [Redaction](#redaction)
- [Options](#options)
- [Limits](#limits)
  - [How large a conversation can be decided](#how-large-a-conversation-can-be-decided)
- [`providerDecision`](#providerdecision)
- [What a compaction reports](#what-a-compaction-reports)
- [Development](#development)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Install

From the marketplace, on Claude Code 2.1.275 or later:

```sh
claude plugin install decision-compaction --marketplace zchee/claude-code-mods
```

From a checkout, without installing:

```sh
claude --plugin-dir mods/decision-compaction
```

Then set a credential for the provider you want (see
[Providers](#providers)), for example `TYPESAFE_API_KEY` in the
environment, or the `typesafeApiKey` option in `/config`.

Options are read from settings under `pluginConfigs` and appear in
`/config`. A mod loaded with `--plugin-dir` is keyed
`decision-compaction@inline` (the bare `decision-compaction` is read too);
an installed one is keyed by its plugin id, `decision-compaction@<marketplace>`.

## How it works

### On `session.compact`

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
   hold nothing but calls merged into one entry. For a provider that caps
   the request body in bytes, the same reductions go on until the state
   also fits that cap with room left for one request's questions. Sizes
   are estimates; no tokenizer is used.
3. Puts two yes/no questions to the provider for every call left to judge:
   is the call itself still needed, and is its complete output still
   needed word for word. A request holds as many of these questions as the
   token budget, the provider's own limit on questions and, for a provider
   that caps the body in bytes, that cap allow, and each request carries
   the full state. See [Limits](#limits) for the bounds.
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

**It fails open.** On any error (a missing key, a `provider` option that
names no provider, an HTTP error, a request that is rejected, a compaction
whose requests are not answered in time, a malformed answer, a conversation
that cannot be fitted or would take too many requests) and when the
decisions would remove less than `minReductionRatio`, it says why in one
line and lets the built-in summary run. A `precompute` compaction is always
left to the engine.

Every request that asks about a tool call goes to one provider: the
configured one, or the one the provider decision picked. Nothing falls over
to another provider. With `providerDecision` on there can be one more
request before them, the routing question, and it may go to a different
provider (see [`providerDecision`](#providerdecision)).

### On `turn.complete`

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

| `provider` | Endpoint | Model by default | Credentials | Documented limits |
| --- | --- | --- | --- | --- |
| `typesafe` (default) | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` | 64,000 tokens a request; 32,000 for the state plus the longest question |
| `cloudflare` | `https://api.cloudflare.com/client/v4/accounts/<account id>/ai/run/@cf/cloudflare/<model>` | `clef` (`clef-flash` and `clef-omni` are the others) | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` | 64,000 tokens on `clef` and `clef-omni`, 24,000 on `clef-flash` (see below); 64 questions a request |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | `~typesafe/jev-latest` | `OPENROUTER_API_KEY` | 32,000 tokens for the state plus the questions; 64 questions a request for any model other than Jev |
| `codiv` | `https://api.codiv.ai/v1/systemone` | `openjev-latest` (OpenJev) | `CODIV_API_KEY` | 65,536 tokens for the state and the questions together (the vendor advises a state of about 60,000); no limit on questions |
| `perplexity` | `https://api.perplexity.ai/v1/decisions` | `pplx-decider-v1.1-27b` | `PERPLEXITY_API_KEY` | under 262,144 tokens a request; 128 questions a request |
| `decisions-api-dev` | `https://decisions-api.dev/v1/systemone` | `jev-latest` (Jev, through this gateway) | `DECISIONS_API_KEY` | 32 KiB a request body, counted in bytes, so text that is not ASCII uses more of it; 8 questions a request |
| `decisionapi-net` | `https://decisionapi.net/v1/systemone` | `jev-latest` (Jev, through this gateway) | `DECISIONAPI_API_KEY` | 32 KiB a request body, counted in bytes; 8 questions a request |
| `openai` | `https://api.openai.com/v1/decisions` | `gpt-6-luna` | `OPENAI_API_KEY` | not documented for the Decisions API; the mod holds a request to 32,000 tokens and 64 questions |

The `provider` option takes exactly these eight names. Any other value is
not replaced by the default: nothing is sent anywhere, and every compaction
uses the built-in summary with a line naming the value. Only an option left
unset or empty means `typesafe`. For that reason `/config` shows the option
as a text field rather than a list (a list would let the engine turn an
unknown value into the default without saying so).

What differs between the providers beyond the table:

- `openrouter`, `decisions-api-dev` and `decisionapi-net` are gateways to
  TypeSafe's Jev. `codiv`'s OpenJev is a model of its own, not TypeSafe's
  Jev: at Codiv `jev-latest` is an alias of OpenJev.
- `cloudflare` holds each Clef model to the count a cut state reports,
  measured on 2026-10-11: a text state too long for the window is cut
  without a word, and the reply then counts exactly 64,000 input tokens on
  `clef` and `clef-omni` and 24,000 on `clef-flash`. The catalogue states
  65,536 for `clef` and 24,576 for `clef-flash`; a limit at those figures
  would never see the cut. `clef-omni` is a 30B mixture-of-experts model
  (3B active) that also reads audio, at $0.15 per million input tokens
  against $0.24 for `clef` and $0.038 for `clef-flash`.
- `perplexity` accepts only its own decider models. Any other name in
  `model`, `jev-latest` included, is refused with an HTTP 400 and the
  compaction uses the built-in summary. Its `usage.input_tokens`, and so
  its bill at $0.02 per million, counts the state once for every question:
  a compaction of a 200,000-token state with 300 questions is billed about
  60 million input tokens.
- `decisions-api-dev` and `decisionapi-net` wrap the answer in a
  `{code, message, data}` envelope. A `code` other than 0, or an envelope
  without `data.result`, ends the compaction with the vendor's message
  quoted, as for any other failed request.
- `decisions-api-dev` accepts a question id only if it starts with a
  letter, uses letters, digits, `_` and `-`, and is at most 64 characters.
  The mod's ids can hold `.` and run longer, so it names each question in
  a request by its place (`q0`, `q1`, …) and maps the answers back to the
  ids. An answer under a name the mod did not send is refused.
- `openai` takes a different request: the state goes as one JSON string in
  `input` and the questions as a list, each a `predicate` (yes/no) or a
  `choice`. The mod translates the request into that form and the answers
  back. OpenAI counts about 148 input tokens for each question (Codiv
  about 26 for the same one-line question), and the mod's size estimate
  adds that figure per question. If OpenAI refuses to answer a question
  (the line reads `openai: refused to answer <question id>`), or answers in
  a shape the mod does not read, the compaction ends with the built-in
  summary and the line names the question or the field.

`~typesafe/jev-latest` is OpenRouter's alias for the newest Jev;
`typesafe/jev-1.13` pins a release. OpenRouter also takes TypeSafe's bare
ids and maps them itself (`jev-latest` to `~typesafe/jev-latest`,
`jev-1.13` to `typesafe/jev-1.13`). An id that already has an author prefix
is used as written.

OpenRouter also serves Cloudflare's Clef (`cloudflare/clef`,
`cloudflare/clef-flash`), and passes such a request on to Cloudflare, which
refuses one with more than 64 questions. A model other than Jev on
`openrouter` is therefore asked at most 64 questions (32 tool calls) a
request, as on `cloudflare`, while the token limits stay OpenRouter's,
except where OpenRouter cuts a Clef state shorter: `cloudflare/clef` and
`cloudflare/clef-flash` were cut at 16,384 tokens on 2026-10-11, so they
are held to that, and `cloudflare/clef-omni` to OpenRouter's 32,000.

### Credentials

Each credential is read from its plugin option first, then from the
environment, at the time of the compaction. The `env` block of the settings
is read only when a credential a provider in play needs is still missing;
if the settings cannot be read, that is logged and the compaction goes on
with what it has. With `providerDecision` on and `decisionProviders` at
its default of all eight providers, some key is usually unset, so the
settings are read on most compactions.

### Redaction

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
| `providerDecision` | `false` | Decide the provider per compaction; see [`providerDecision`](#providerdecision). |
| `decisionProviders` | all eight providers | With `providerDecision` on, the providers that may be compared and so may receive the conversation: a list of provider names, or one text of names separated by commas. The configured provider is always considered. See [`providerDecision`](#providerdecision). |
| `typesafeApiKey` | unset | TypeSafe API key (stored as a secret). |
| `openrouterApiKey` | unset | OpenRouter API key (stored as a secret). |
| `cloudflareApiToken` | unset | Cloudflare API token allowed to run Workers AI (stored as a secret). |
| `cloudflareAccountId` | unset | Cloudflare account ID. |
| `codivApiKey` | unset | Codiv API key (stored as a secret). |
| `perplexityApiKey` | unset | Perplexity API key (stored as a secret). |
| `decisionsApiKey` | unset | decisions-api.dev API key (stored as a secret). |
| `decisionapiApiKey` | unset | decisionapi.net API key (stored as a secret). |
| `openaiApiKey` | unset | OpenAI API key (stored as a secret). |
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
  54,400 on `cloudflare` `clef` and `clef-omni` and 20,400 on
  `clef-flash`, 27,200 on `openrouter` and `openai`, 51,000 for
  the state plus the longest question (85% of the 60,000 the vendor
  advises) and 55,705 a request on `codiv`, 222,821 on `perplexity`, and
  27,200 for the state plus the longest question and 54,400 a request on
  `decisions-api-dev` and `decisionapi-net`. Both serve TypeSafe's Jev
  1.13 and state their own limit in bytes, so they are held to the token
  window TypeSafe documents for Jev, and the byte cap below is the bound
  that decides. `openai` documents no limit, so it is
  held to the tightest figures of the others, 32,000 tokens and 64
  questions, before the margin. Where the margin leaves less than the
  default `maxRequestTokens` of 30,000 (`openrouter` and `openai`), the
  default is lowered there.
- **A byte cap.** `decisions-api-dev` and `decisionapi-net` also hold a
  request to the 85% share of their 32 KiB cap, 27,852 of 32,768 bytes,
  measured as UTF-8 of the encoded request body, since a body over the cap
  is refused whole. When one of them is the configured provider the state
  is fitted to that cap as well as to its tokens: the reductions above go
  on until the body, with the questions of one request set aside (4 tool
  calls, all that 8 questions hold), fits in 27,852 bytes. English prose
  takes more bytes for each estimated token than the token budget allows
  for, and text that is not ASCII more still, so on these two providers it
  is usually the bytes that decide how much of the conversation the model
  sees. Questions are counted at or above the bytes they are sent in
  (`decisions-api-dev` counts each under the longest name it may send,
  `q7`). A conversation still over the cap after every reduction is left
  to the built-in summary, and the line says how many bytes were left.
  With `providerDecision` on, the state is fitted for the configured
  provider, so one of these two offered as another route may have no room
  for a question within the cap; it is then ruled out, and the line says
  how many of the 27,852 bytes the request takes before any question.
- **A reply that shows a cut.** If a provider reports as many input tokens
  as the request limit the mod holds for it (before the margin), the state
  was probably cut short. The answers are discarded and the built-in
  summary runs. On `decisions-api-dev` and `decisionapi-net` that limit is
  Jev's own 64,000 tokens, which a body within 32 KiB does not reach. On
  `openai` it is the mod's fallback of 32,000, not a window OpenAI states,
  so a reply counting that many is discarded even if the model read the
  state whole. `perplexity` counts the state again for every question of
  a request, so its count is divided by the number of questions before it
  is held to the limit: 128 questions on a 12,000-token state report about
  1,530,000 input tokens and were read whole.
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
  exception: the configured provider then decides, as described under
  [`providerDecision`](#providerdecision).
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

The table has no rows for `codiv`, `perplexity`, `decisions-api-dev`,
`decisionapi-net` and `openai`; it was not measured on them.
`decisions-api-dev` and `decisionapi-net` take 8 questions and 32 KiB a
request, so of a long conversation the model sees only what is left once
the state is shrunk to the cap. The cap counts bytes, so text that is not
ASCII uses more of it. Eight questions are the questions of 4
tool calls, so a compaction asks about at most 64 calls over its 16
requests.

## `providerDecision`

Off by default: the configured provider is always used, and no other
provider is sent anything.

When on, the providers considered are the configured one and those in
`decisionProviders`. Unset, that option is every provider, all eight. It
takes a list of names, or one text of names separated by commas; a cleared
field (an empty text) or an empty list names none, so only the configured
provider is considered.
A name that is no provider is dropped and named in one line of the
transcript; the compaction goes on, because dropping a name can only
narrow where data goes. A provider that is not considered is sent nothing,
even when its credentials are set. A provider that is considered is a
candidate as soon as its credentials resolve, so a key exported for
another tool makes that vendor eligible. To keep the choice to the
original three providers, set `decisionProviders` to
`typesafe,cloudflare,openrouter`.

The mod first drops every route it can rule out in code: a provider whose
credentials are unset, whose limits the fitted state exceeds, or that would
need more than 16 requests. Cloudflare contributes three routes (`clef`,
`clef-flash` and `clef-omni`). Among routes to the same model one is
offered: the direct route when it is usable, otherwise the first gateway
in the order `openrouter`, `decisions-api-dev`, `decisionapi-net`. Jev is
reached directly through `typesafe` and through those three gateways;
on OpenRouter an id that names Jev (`jev`, `jev-…`, alone or under
`typesafe/` or `~typesafe/`) is Jev. Every other route to that model is
left out, with the reason "the same model as" the one offered. Any other
OpenRouter id, under `typesafe/` included, is a model of its own. If two
or more routes remain, one `choice` question is asked over a small
profile of the job (message and call counts, state size, tool mix, error
share, share of non-ASCII text, and the goal), not over the conversation.
The goal is your own text: what you typed after `/compact`, cut to 2,000
characters, or your last three prompts, cut to 500 characters each. The
question is asked on Cloudflare `clef-flash` only when `cloudflare` is
one of the providers considered and its credentials are set, otherwise on
the configured provider. A `decisionProviders` list
without `cloudflare` therefore keeps the profile away from Cloudflare,
unless Cloudflare is the configured provider. The option descriptions
state only what the providers document about their models.

With one route left, or when the routing request fails, the configured
provider is used and the reason is logged. That includes the case where the
configured provider is a gateway to Jev (`openrouter`, `decisions-api-dev`
or `decisionapi-net`) and the one route left is TypeSafe's direct route to
the same model. The one exception: if the configured
provider cannot take the job and exactly one other route can, that route is
used. With no route left at all the built-in summary runs, and its line
lists every route with the reason it was ruled out. A routing question
still unanswered when the compaction's 30 seconds run out does not hand
the job to the configured provider: the built-in summary runs.

## What a compaction reports

Each compaction ends with one line, in a toast and in the log, for example
`compacted without a summary: 41 of 96 messages remain (...)`, with what
happened to the tool calls, the provider and model used, the estimated size
of the state, and the input tokens the provider counted. On `perplexity`
that count is the state times the questions of the largest request, which
is what Perplexity bills, not the size of one reading. A `per-call
verdicts:` line lists both probabilities for every call asked about.

## Development

```sh
claude plugin validate --strict mods/decision-compaction
claude plugin test mods/decision-compaction
```

The tests use a fake provider at the `$.http.fetch` seam and never reach a
network. From the repository root, `pnpm run check` runs them with the
type check and the strict validation of every mod.

To send one synthetic request to every provider whose key is in the
environment, through the mod's own request builder and reply parser:

```sh
pnpm run live:decision-compaction
```

It prints one verdict line per provider and no secret, and exits non-zero
when any provider it called failed. Nothing from a real conversation is
sent.

A hot reload of the mod while a compaction is running cancels the mod's
pending waits, the deadline's timer among them, so that compaction's
30-second bound does not hold across the reload. This matters only while
the mod is being developed.

## Acknowledgements

The algorithm follows the design of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT); the code here is an independent implementation.

## License

[Apache-2.0](../../LICENSE).
