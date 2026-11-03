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
  - [Budgets by route](#budgets-by-route)
  - [How large a conversation can be decided](#how-large-a-conversation-can-be-decided)
- [`providerDecision`](#providerdecision)
- [What a compaction reports](#what-a-compaction-reports)
- [Development](#development)
  - [Benchmark](#benchmark)
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
   hold nothing but calls merged into one entry. A state that shows the
   start of each output (a benchmark setting, off in every compaction; see
   [Result heads](#result-heads)) drops those starts before anything else
   (`result heads dropped`). For a provider that caps
   the request body in bytes, the same reductions go on until the state
   also fits that cap with room left for one request's questions. Sizes
   are estimates; no tokenizer is used.
3. Puts two yes/no questions to the provider for every call left to judge:
   "Will the assistant need the fact that it ran <the call>, and with which
   input, to carry on with the goal?" and "Will the assistant need the
   exact output of <the call>, <its length> characters long, for the next
   step of the goal, rather than a summary or a fresh run?" The state's
   context tells the model that what the assistant does next depends on
   the newest prompt in the goal (see [Wordings](#wordings) for how this
   wording was chosen). A request holds as many of these questions as the
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

### When Claude Code passes the mod over

Claude Code can seat its built-in `cc-plugin-sec-default` plugin before the
plugins you install, and that plugin sends every `session.compact` past
them. The transcript then says `decision-compaction: its session.compact
hook was skipped. "cc-plugin-sec-default" runs first and sent the event on
past it.`, and every compaction of the session is the built-in summary. No
setting of yours changes that: the mod has no other way to compact, and
Claude Code ignores `appendPlugins` in your user settings in such a session.
Only your organization can place the mod beneath that plugin, by listing it
in `appendPlugins` in its managed settings.

Claude Code seats the plugin, in Claude Code 2.1.306:

- on a Team or Enterprise plan,
- on a machine with managed settings, or a managed MCP server file,
- by default, on any plan, while Claude Code cannot yet tell that neither
  of those applies (its server-managed settings request has not answered
  that there are none). A managed `prependPlugins` that leaves the
  plugin out does not stop this default seat.

Once seated, the plugin stays seated until the Claude Code process ends;
`/clear` and compaction keep it.

In such a session the `turn.complete` trigger would only run the built-in
summary at `compactAtPercent`, earlier than Claude Code's own threshold and
again at every later crossing. So the first compaction it requests that
does not reach the mod's own hook stops it until the process ends, with
a line and a toast saying why; Claude Code's own auto-compaction then
decides when to compact. A compaction a hook above the mod vetoes, and one
that fails, stop nothing.

## Providers

| `provider` | Endpoint | Model by default | Credentials | Documented limits |
| --- | --- | --- | --- | --- |
| `typesafe` (default) | `https://api.typesafe.ai/v1/systemone` | `jev-latest` (Jev 1.13; `jev-1.14.0` is Jev 1.14) | `TYPESAFE_API_KEY` | 64,000 tokens a request; 32,000 for the state plus the longest question; the same for Jev 1.13 and 1.14 |
| `cloudflare` | `https://api.cloudflare.com/client/v4/accounts/<account id>/ai/run/@cf/cloudflare/<model>` | `clef` (`clef-flash` and `clef-omni` are the others) | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` | 64,000 tokens on `clef` and `clef-omni`, 24,000 on `clef-flash` (see below); 64 questions a request |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | `~typesafe/jev-latest` (Jev 1.14) | `OPENROUTER_API_KEY` | 262,144 tokens for the state plus the questions, with a request of more than about 32,000 bytes of text run in TypeSafe's slower, less accurate long-context mode; 64 questions a request for any model other than Jev, fewer for the models measured to refuse more (see below) |
| `codiv` | `https://api.codiv.ai/v1/systemone` | `openjev-latest` (OpenJev) | `CODIV_API_KEY` | 65,536 tokens for the state and the questions together (the vendor advises a state of about 60,000); no question limit documented, 256 a request measured |
| `perplexity` | `https://api.perplexity.ai/v1/decisions` | `pplx-decider-v1.1-27b` | `PERPLEXITY_API_KEY` | under 262,144 tokens a request; 128 questions a request |
| `decisions-api-dev` | `https://decisions-api.dev/v1/systemone` | `jev-latest` (Jev 1.13, through this gateway; `typesafe/jev-1.14` is Jev 1.14) | `DECISIONS_API_KEY` | 32 KiB a request body, counted in bytes, so text that is not ASCII uses more of it; 8 questions a request |
| `decisionapi-net` | `https://decisionapi.net/v1/systemone` | `jev-latest` (Jev 1.14 as documented, through this gateway) | `DECISIONAPI_API_KEY` | 32 KiB a request body, state and questions together, counted in bytes; 8 questions a request |
| `openai` | `https://api.openai.com/v1/decisions` | `gpt-6-luna` | `OPENAI_API_KEY` | 1 to 200 questions a request; no token limit documented for the Decisions API, so the mod holds a request to 272,000 tokens, where the price doubles |

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
- Jev 1.13 and Jev 1.14 are two models, and an alias names a different one
  at each provider. On 2026-10-16 TypeSafe's `jev-latest`, "the most recent
  stable, official release", was Jev 1.13 and its `jev-preview` Jev 1.14
  (available from 2026-10-14); OpenRouter's `~typesafe/jev-latest`, which
  "tracks the newest release", and decisionapi.net's default were Jev 1.14;
  decisions-api.dev's `jev-latest` answered as Jev 1.13. TypeSafe takes
  `jev-1.14.0`, the gateways `typesafe/jev-1.14`. To keep answers from one
  release, name it rather than an alias: an alias moves when a release
  ships.
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
`typesafe/jev-1.14` and `typesafe/jev-1.13` pin a release. OpenRouter also
takes TypeSafe's bare ids and maps them itself (`jev-latest` to
`~typesafe/jev-latest`, `jev-1.13` to `typesafe/jev-1.13`). An id that
already has an author prefix is used as written.

OpenRouter documents a window of 262,144 tokens for Jev, and sends a
request "with more than about 32,000 bytes of text" to TypeSafe's
long-context mode, which TypeSafe calls slower and less accurate than its
default limits. The mod therefore asks OpenRouter's Jev for a body within
that (see [Budgets by route](#budgets-by-route)), and holds a request to
the window only when the conversation does not fit it or you set a request
budget.

OpenRouter also serves Cloudflare's Clef (`cloudflare/clef`,
`cloudflare/clef-flash`, `cloudflare/clef-omni`), and passes such a request
on to Cloudflare, which refuses one with more than 64 questions. A model
other than Jev on `openrouter` is therefore asked at most 64 questions (32
tool calls) a request, as on `cloudflare`, and held to where OpenRouter cuts
its state: `cloudflare/clef` and `cloudflare/clef-flash` were cut at 16,384
tokens on 2026-10-11, the window of the cheapest host OpenRouter sends them
to, and `cloudflare/clef-omni`, which only Cloudflare hosts, at 64,000. Any
other model it forwards is held to 32,000 tokens, since no limit of its is
documented here. Measured on 2026-11-03, `nace-ai/drex-max` and
`nace-ai/drex-v2.0` take 16 questions a request and 16 requests a
compaction, so a conversation with more than 128 judged calls is refused
before anything is sent (`session-230` needs 29 requests).
`togethercomputer/tev1-4b-experimental` and `upstage/solar-decide` are
asked at most 8 questions a request, which is 64 judged calls a compaction
at most. At 32, tev1 failed five of nine compactions, each on its counting
of the state once a question, and solar-decide six, five of them past the
30-second deadline. Asked 8 on seven scenarios, tev1 answered all seven
within the 32,000-token window, which it keeps; since it bills the state
once a question, a 23,000-token conversation (`prose-60`) costs about
$0.09 a compaction. Asked 8 questions and counted per question,
solar-decide answered four of seven scenarios, in a median of 15.1
seconds; the three it missed (`exploration`, `prose-60`, `session-22`)
each need three or more requests and none finished within the 30-second
deadline, so a conversation of more than 8 judged calls is unlikely to get
an answer from it in time. `upstage/solar-decide-flash` is asked at most
32. The input tokens tev1, both Upstage models and `respan/span-02` count
are divided by the questions asked before they are compared with the
window, since those four count the state once a question, as `perplexity`
does.

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
| `maxStateTokens` | the route's own | Most estimated tokens the state may take, a whole number; unset, each route asks for its own (see [Budgets by route](#budgets-by-route)). |
| `maxRequestTokens` | the route's own | Most estimated tokens one request may take, state and questions together, a whole number; unset, each route asks for its own (see [Budgets by route](#budgets-by-route)). |
| `truncateHeadChars` | `300` | Characters kept of a shortened output; at `0` only the note remains. |

## Limits

The bounds below are fixed; they are not options.

- **Margin under the documented limits.** The token estimate is made
  without a tokenizer and its weights were fitted to Jev, and Cloudflare
  cuts a state that is too long without saying so. A budget is therefore
  held to 85% of the provider's documented limit: 27,200 tokens for the
  state plus the longest question and 54,400 a request on `typesafe`,
  54,400 on `cloudflare` `clef` and `clef-omni` and 20,400 on
  `clef-flash`, 222,822 on `openrouter`'s Jev (13,926 on its `clef` and
  `clef-flash`, 54,400 on its `clef-omni` and 27,200 on any other model
  it forwards), 231,200 on `openai`, 51,000 for the state plus the longest
  question (85% of the 60,000 the vendor advises) and 55,705 a request on
  `codiv`, 222,821 on `perplexity`, and 27,200 for the state plus the
  longest question and 54,400 a request on `decisions-api-dev` and
  `decisionapi-net`. Both serve TypeSafe's Jev and state their own limit
  in bytes, so they are held to the token window TypeSafe documents for
  Jev, and the byte cap below is the bound that decides. `openai`
  documents 1 to 200 questions and no token limit for its Decisions API.
  On 2026-10-11 it answered a state of 300,000 tokens in under two
  seconds; a request over "272K" input tokens is billed at twice the
  rate, so it is held to 272,000 tokens and 200 questions before the
  margin. `codiv` documents no question limit but
  refused 300 questions (at most 256 a request), so it is held to 256.
  A budget you set is held to these figures, and so is the one a route
  asks for when you set none (see [Budgets by route](#budgets-by-route)).
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
- **A byte cap that is asked for, not required.** `openrouter`'s Jev
  answers a body of any size within its window, but runs one of more than
  about 32,000 bytes in TypeSafe's long-context mode. With
  `maxRequestTokens` unset, a request to it is therefore held to 27,200
  bytes (85% of 32,000) the way the two resellers are held to theirs, with
  two differences: when the conversation cannot be fitted under it, or its
  calls would then take more than 16 requests, the cap is dropped, the
  state is fitted again without it and the requests run in the
  long-context mode, rather than the built-in summary running; and with
  `providerDecision` on, it never rules `openrouter` out. A small session
  is thus decided in the default mode from a tighter state, and a larger
  one in the long-context mode from a fuller state. The line of each
  compaction says which (`requests within the 27200 bytes openrouter asks
  for`, or `past` them). A request budget you set drops the cap.
- **A reply that shows a cut.** If a provider reports as many input tokens
  as the request limit the mod holds for it (before the margin), the state
  was probably cut short. The answers are discarded and the built-in
  summary runs. On `decisions-api-dev` and `decisionapi-net` that limit is
  Jev's own 64,000 tokens, which a body within 32 KiB does not reach. On
  `openai` it is the 272,000 where the price doubles: OpenAI refuses a
  request too long rather than cutting it, so a reply counting that many
  is one whose estimate drifted, and is discarded all the same.
  `perplexity` counts the state again for every question of
  a request, so its count is divided by the number of questions before it
  is held to the limit: 128 questions on a 12,000-token state report about
  1,530,000 input tokens and were read whole. `codiv` refuses a request too
  long for its window with HTTP 400 rather than cutting it, and counts the
  state once for every chunk of about thirteen questions, so its count is
  not held to the limit at all.
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

### Budgets by route

Leave `maxStateTokens` and `maxRequestTokens` unset and each route asks
for its own, sized from what it was measured to read on 2026-10-11. A
compaction sends at most 16 requests, three at a time, under a 30-second
deadline, so each request should be answered in about four and a half
seconds with 32 questions in it; the state is the largest that does.
Where the state is read once a request (Jev, Clef, OpenAI), the request
budget takes the provider's whole window, so that a compaction needs
fewer requests, each of which carries the state. Where it is read once a
question (`perplexity`) or once a chunk of about thirteen questions
(`codiv`), a fuller request is only slower, so the request budget is the
state and the questions of 16 calls beside it. The margin above then
holds both, as it does a budget you set.

| Route | `maxStateTokens` | `maxRequestTokens` | Measured with 32 questions |
| --- | --- | --- | --- |
| `typesafe` (`jev-latest`, Jev 1.13, and `jev-1.14.0`) | 27,000 | 54,400 | a 23,000-token state in 0.4 s (2026-10-11); 27,000 in 0.36 s on both releases, and 1,500 questions on 24,000 in 0.85 s on Jev 1.14 (2026-10-16); a state over 32,000 is refused, not cut |
| `cloudflare` `clef` | 30,000 | 54,400 | 30,000 tokens in 4.1 s, 49,000 in 7.4 s |
| `cloudflare` `clef-flash` | 14,000 | 20,400 | 10,000 tokens in 3.1 s, 19,000 in 5.3 s |
| `cloudflare` `clef-omni` | 45,000 | 54,400 | 49,000 tokens in 3.4 s |
| `openrouter` Jev | 27,000 | 54,400, and 27,200 bytes a body while the conversation fits them | as `typesafe`; the bytes keep a request out of the long-context mode |
| `openrouter`, any other model | 27,000 | 27,200 | held to the window it reads: 16,384 on `cloudflare/clef` and `cloudflare/clef-flash`, 64,000 on `cloudflare/clef-omni`, 32,000 on any other |
| `codiv` | 25,000 | 30,000 | 30,000 tokens in 4.8 s; 128 questions on 49,000 in 24 s |
| `perplexity` | 10,000 | 14,000 | 15,000 tokens in 6.3 s; 8 questions on 30,000 in 3.1 s |
| `decisions-api-dev`, `decisionapi-net` | 27,000 | 54,400 | not measured; the 32 KiB byte cap binds first |
| `openai` | 200,000 | 231,200 | 225,000 tokens in 1.6 s; costs $0.10 per million input tokens for every request |

A budget you set applies to every route alike. With `providerDecision` on
and the budgets unset, each route is held to its own, so a route that
asks for a smaller state than the one fitted for the configured provider
is ruled out ("the state is about … tokens and it takes …").

What the providers themselves recommend, read on 2026-10-16, changes
only `openrouter`'s Jev; everywhere else the measured speed above binds
tighter than anything they document:

- TypeSafe gives no state size to aim for. It says to send only what a
  question needs, since unrelated state costs accuracy, and to turn on its
  long-context mode only for requests that need it, as it is slower and
  less accurate; the mod never sends its header for it.
- OpenRouter documents Jev's window as 262,144 tokens and sends a request
  of more than about 32,000 bytes of text to that long-context mode,
  hence the byte cap it is asked to stay within.
- Cloudflare documents each Clef model's window and 64 questions, and
  that the questions share the window with the state, which is cut to fit
  what they leave. It recommends no state size.
- Codiv advises keeping the state at about 60,000 tokens of its 65,536,
  which is the limit the mod holds it to; the measured speed asks for
  less.
- Perplexity documents its latency (5 seconds at about 90,000 tokens, 23
  seconds near the limit) and advises a client timeout of 30
  seconds, 10 for small inputs; at 32 questions the measured speed above
  asks for far less.
- decisions-api.dev and decisionapi.net document only their 32 KiB and 8
  questions.
- OpenAI documents 1 to 200 questions and that independent questions
  about one input belong in one request. Its rate limits are per account
  tier: on the lowest, 2,000,000 tokens a minute, a compaction of more
  than eight requests at the default 231,200 tokens each can be answered
  HTTP 429. Lower `maxRequestTokens` if you see that.

### How large a conversation can be decided

At budgets of 25,000 and 30,000 tokens, the defaults before each route
had its own, the state holds about 25,000 estimated tokens after every
reduction, and 16 requests ask about a bounded number of calls. Past
either bound the result is always the built-in summary.

The table is a measurement at those budgets, not a guarantee. It was
taken with a fake provider on a synthetic session made only of `Read`
calls with short file paths and 600-character outputs, between one
opening and one closing prompt. A real session has longer inputs, more
varied tools and more text, so its limits are lower, and differ from one
session to the next; read the numbers as rough orders of size.

| `provider` | Calls whose assistant message also carries a sentence of text | Call-only messages |
| --- | --- | --- |
| `typesafe` | roughly 400 (then the state no longer fits) | roughly 900 (then a 17th request) |
| `cloudflare` | roughly 400 (then the state no longer fits) | 512 (32 calls a request) |

`openrouter` had a row here, measured against the 32,000-token window the
mod held it to before 2026-10-16; neither that window nor those budgets
exist any more, and it has not been measured since.

Longer tool inputs and longer tool names lower these numbers. Raising
`maxStateTokens` and `maxRequestTokens` raises them, up to the margins
above.

The table has no rows for `openrouter`, `codiv`, `perplexity`,
`decisions-api-dev`, `decisionapi-net` and `openai`; it was not measured
on them.
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
credentials are unset, whose limits or budget the fitted state exceeds,
or that would need more than 16 requests. With the budgets unset each
route has its own (see [Budgets by route](#budgets-by-route)), so a route
that asks for a smaller state than the configured provider's is dropped
when the conversation fills the larger one. Cloudflare contributes three routes (`clef`,
`clef-flash` and `clef-omni`), and TypeSafe two (`jev-latest`, Jev 1.13,
and `jev-1.14.0`), as does `decisions-api-dev` (`jev-latest` and
`typesafe/jev-1.14`). Among routes to the same model one is offered: the
direct route when it is usable, otherwise the first gateway in the order
`openrouter`, `decisions-api-dev`, `decisionapi-net`. Each Jev release is
a model of its own, reached directly through `typesafe` and through those
three gateways. An id that names Jev (`jev-…`, alone or under `typesafe/`
or `~typesafe/`) is the release it pins, or for an alias the release that
provider's alias named on 2026-10-16 (see [Providers](#providers)); a Jev
id that names no known release is taken for none of them. Every other route to that model is
left out, with the reason "the same model as" the one offered. Any other
OpenRouter id, under `typesafe/` included, is a model of its own. With
TypeSafe's key set, there are always two Jev releases to choose between,
so the routing question below is asked even when no other provider has a
key; name a release in `model` (`jev-1.13.0`) to offer only that one. If two
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
or `decisionapi-net`) and the one route left is another route to the same
release. The one exception: if the configured
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
is what Perplexity bills, not the size of one reading; on `codiv` it is
the state times the chunks of about thirteen questions it answers in, which
is what its quota counts. On `openrouter`'s Jev the line also says
whether every request stayed within the 27,200 bytes that keep it in
TypeSafe's default mode. A `per-call
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

### Benchmark

The benchmark runs the conversations in `bench/corpus.ts` through every
model whose key is in the environment, and compares what each one decides
with the actions the corpus labels as right for every call:

```sh
pnpm run bench:decision-compaction --dry-run
pnpm run bench:decision-compaction --provider cloudflare --model clef-flash --scenario fix-test
pnpm run bench:decision-compaction --out /tmp/bench.json
```

Six of the conversations are written by hand; the three `session-*` ones are
generated in the shape measured from real sessions (`bench/generate.ts`,
from the statistics in `bench/shape.ts`). Nothing from a real conversation
is sent. Each compaction goes through the mod's own `run()`, with
`providerDecision` off so that it stays on one route and
`preserveRecentMessages` at 6. Compactions run one at a time, so the time
measured is that compaction's alone. A route whose key is unset prints one
`skip` line, as the smoke script does.

Before the first request goes out, a run prints how many compactions it
plans (`planned: N compactions (R routes x S scenarios x n repeats)`) and
the first request of each, as a dry run shows them below, so the spend is
seen before it is incurred.

It prints one table per scenario and one summary per route. A scenario's
table gives, per route, whether the compaction succeeded, its requests and
time, the `stage` the state was fitted at, the state's tokens, whether the
byte cap the route asks for held (`asked bytes held`, `-` for a route
without one), the reduction, the calls kept, cut and dropped, the share of
calls whose action the labels accept, the harmful drops (`harmful`: a call
the labels say to keep alone that was dropped), the lossy cuts (`lossy`: such
a call that was kept with its result cut to its head, which costs less,
since the call stays and the rest can be read again), the tokens and cost the
provider reported, and the release a model answered as. The summary gives
the same per route across its runs, with the distinct `stages` joined by
`/`, the median probabilities the route gave to the calls labelled `keep`
alone (`keep P(call)` and `keep P(result)`, over those calls of all its
successful runs pooled), and a `degenerate` column that reads `keeps
nothing` or `keeps everything` when a route kept none or all of the calls
it judged (a cut call is not kept). After
the summary come the calls on which more than half of the routes that ran
them disagreed with the label, one line each with every route's action and
the routes that agreed (`agreed by: ...`, or `none`), or `no call disputed
by most routes`: a label most models contradict is more likely wrong than
the models, and is to be checked by hand. A rule of every route would let
one route that keeps everything hide every `keep` label. Every line, and every
file written with `--out`, passes through the mod's redaction with every
resolved credential, an error's included. The JSON holds ids, actions,
probabilities and figures, never a conversation's text or a request.

The figures compare routes as the mod drives them, not models on the same
input: each route has its own question cap, wire format, byte cap and
budgets, and a route that had to cut the state may disagree with the labels
for that reason alone. The `stage` column tells the two apart.

| Flag | What it does |
| --- | --- |
| `--provider <name>` | Only this provider; repeatable. |
| `--model <name>` | Only this model, of the one `--provider` given. Any id is accepted. |
| `--scenario <id>` | Only this scenario; repeatable. |
| `--repeat <n>` | Compactions per route and scenario (1 by default); the summary then gives medians and how often the actions agreed across repeats. |
| `--dry-run` | Builds each route's first request through the mod and sends nothing. |
| `--questions <name>` | The wording asked in: `current` (the default, the mod's own), `legacy`, `call-need` or `result-exact`; see [Wordings](#wordings). |
| `--state none\|head:<n>` | What the state shows of each call's output: nothing (`none`, the default, what a compaction sends) or its first n characters, n from 1 to 1000 (`head:<n>`, only with `--questions current`); see [Result heads](#result-heads). |
| `--openrouter-catalog static\|live\|off` | The OpenRouter-only models below: the table in `bench/openrouter-catalog.ts` (`static`, the default), OpenRouter's listing fetched now (`live`, which prints the ids the table lacks and the ones the listing dropped), or none (`off`). |
| `--out <path>` | Also writes a JSON record of every run. Nothing is written without it. |

A dry run calls `run()` with a `fetch` that throws before anything leaves
the process, and prints, per route and scenario, the first request as it
would go out: its bytes, the state's bytes and estimated tokens, the
questions in it, whether the state is cut (`cut` is `yes` when the state's
bytes are below those of the whole state, `no` when it is the whole, `-`
when no request was caught, because the route failed first or every call
was pinned), and the budget override when one applies. The batch count and
the `stage` are not known before a request is sent: `run()` fits the state
and batches the questions internally, and the dry run stops it at the first
request. The dry run does not print them; the real run's tables do. With
`--openrouter-catalog live` the listing is the one request a dry run makes.

The script exits 1 when any compaction or the bench itself failed, 2 on a
mistake in the command line, 130 after an interrupt (Ctrl-C), and 0
otherwise. An interrupt gives up the compaction under way and starts no
other; a second one ends the process at once. A model that cannot answer the mod's
questions is a `FAIL` row with the redacted reason, and the run goes on.

#### Models only OpenRouter reaches

OpenRouter lists 33 models whose output is a decision
(`GET https://openrouter.ai/api/v1/models?output_modalities=decisions`,
fetched on 2026-11-03 at 08:27 JST). The TypeSafe, Cloudflare, Perplexity
and OpenAI ones the mod reaches directly; the rest run as models of the
`openrouter` route, whose request builder takes any id as written, less
four that do not take System One's request (`NOT_SYSTEM_ONE`): Respan's
`respan/span-01`, `span-01-lite` and `span-01-lite:free` and ScaleDown's
`scaledown/classify-1` answered HTTP 400 to every request on 2026-11-03,
since they take a state of another shape. The sixteen left are:

| Vendor | Model ids | Context (tokens) | Price (per million input) |
| --- | --- | --- | --- |
| Baseten | `baseten/joey-1`, `baseten/elephant-1`, `baseten/mammoth-1` | 16,384 | $0.01, $0.035, $0.10 |
| Inception | `inception/mercury-decide` | 65,536 | $0.02 |
| Jared Palmer | `jaredpalmer/kev-4b` | 8,192 | $0.042 |
| Liquid AI | `liquid/d1`, `liquid/d1.1`, `liquid/d1-ultra` | 65,536; 32,768 (ultra) | $0.02; $0.042 (ultra) |
| Microsoft | `microsoft/microsoft-decision-1` | 32,768 | $0.042 |
| Nace AI | `nace-ai/drex-v1.5`, `nace-ai/drex-v2.0`, `nace-ai/drex-max` | 131,072; 262,144 (max) | $0.04, $0.06, $0.06 |
| Respan | `respan/span-02` | 131,072 | $0.01 |
| Together | `togethercomputer/tev1-4b-experimental` | 32,768 | $0.042 |
| Upstage | `upstage/solar-decide`, `upstage/solar-decide-flash` | 524,288 | $0.05, $0.05 |

The `~liquid/d1-latest` and `~liquid/d1-ultra-latest` aliases are not run
twice; the release a model answered as is in the report. The mod holds a
model it does not know to a 32,000-token window, so a model whose window is
smaller (Baseten's, `kev-4b`) runs with `maxStateTokens` and
`maxRequestTokens` set to its window, and every other one runs at the same
27,200-token state cap as Jev through OpenRouter. The Nace, Together and
Upstage models run with the question caps given under
[Providers](#providers) (16 for `drex-max` and `drex-v2.0`, 8 for `tev1`
and `solar-decide`, 32 for `solar-decide-flash`), so a scenario with more
calls is split over more requests instead of being refused for its question
count, up to 16 requests: `drex-max` and `drex-v2.0` take 16 questions a
request and 16 requests a compaction, so a conversation with more than 128
judged calls is refused before anything is sent (`session-230` needs 29
requests), and `tev1` and `solar-decide` take at most 64 judged calls.
`tev1`'s and `solar-decide`'s input tokens are divided by the questions
asked, as `solar-decide-flash`'s and `span-02`'s are. Jev through
OpenRouter is
also held to the byte cap it asks for, so on the `prose-60` scenario it sees a
smaller state than those models at the same token cap (8,340 estimated
tokens against 23,387 in the table below); the report's caveat says so. A
model that answers in another shape than System One's fails as a row, not
as a crash.

#### Spend

Two full runs on 2026-11-03 (times from `date`). The first, 09:43 to
09:48 JST, in the wording the mod sent until that day (`legacy`): 32
routes, 6 scenarios, 192 compactions; 902,043 input tokens counted by the
providers that report one, $0.0301 reported by the OpenRouter routes, the
only ones that report a price. The second, 10:58 to 11:09 JST, in the
mod's wording now (`current`), after the per-model OpenRouter caps and the
three generated scenarios: 28 routes, 9 scenarios, 252 compactions;
7,060,468 tokens counted and $0.862 reported, of which `solar-decide-flash`
($0.595, 1.9 million tokens) and `span-02` ($0.132, 3.1 million) were, in
that run, the two models counted once per question; every other route
cost under $0.02. The estimate the plan started from (under 8 million
tokens, under $1.50) holds for a run of this size: about ten minutes and
under $1, of which most went to those two models. The next full run will
cost differently: `tev1` and `solar-decide` are now asked 8 questions a
request and counted once per question too, and `tev1` bills the state
once a question (about $0.09 a compaction on `prose-60`).

#### What the runs found

**The first run measured the mod's wording, not the models.** In the
`legacy` wording every mature route (TypeSafe Jev 1.13 and 1.14, Clef,
Clef-flash, Clef-omni, Jev through OpenRouter, GPT-6 Luna, pplx-decider)
answered a probability near zero for both questions on nearly every call
(median 0.01 to 0.16 for the call, 0.00 to 0.10 for the result) and so
dropped everything: 0 kept, 85 to 93 dropped of 93 judged, agreement 61%
at every threshold, 13 harmful drops, every call of `all-needed` among
them. A probe on an invented five-message conversation whose newest
prompt depends on one read gave 0.35 / 0.07 (TypeSafe) and 0.14 / 0.05
(Clef) in that wording and 0.90 / 0.90 and 0.79 / 0.56 in a plain one on
the same state; putting the result's text into the state changed little.
The wording was the cause, and the Wordings section below records the
comparison that chose the one the mod sends now. The same probe repeated
in that wording on 2026-11-03 at 11:14 JST, with a second conversation
whose newest prompt moves to an unrelated task: TypeSafe answers 0.82 /
0.69 where the read is needed and 0.33 / 0.15 where it is not; Clef
answers 0.29 / 0.32 and 0.18 / 0.06, the right way round but both under
the 0.5 threshold, so Clef still drops the read it should keep.

**The second run, in the mod's wording now.** Nine scenarios: the six
hand-written ones and three generated from the shape of this machine's
sessions before `/compact` (see below). Agreement is against labels that
allow `drop` or `truncate` on most calls and `keep` alone on the few the
newest prompt depends on; `harmful` counts a `keep` call cut or dropped,
`missed` a droppable call kept. This run predates the split of `harmful`
into `harmful` and `lossy`, so its `Harmful` figures below are the sum of
the two: 383 = 257 drops + 126 cuts, recounted from its JSON by the
scripts test.

| Route | ok / 9 | Agreement | Harmful | Missed | Kept / cut / dropped | Reduction | Median ms | Tokens counted | Cost | `all-needed` | `session-55` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `typesafe/jev-latest` (Jev 1.14) | 9 | 78% | 17 | 0 | 5 / 10 / 379 | 79% | 225 | 121,063 | - | 50% | 96% |
| `typesafe/jev-1.14.0` | 9 | 75% | 18 | 0 | 4 / 9 / 381 | 81% | 198 | 121,063 | - | 25% | 96% |
| `cloudflare/clef` | 9 | 79% | 14 | 0 | 8 / 3 / 383 | 80% | 1,113 | 109,331 | - | 50% | 98% |
| `cloudflare/clef-flash` | 8 | 68% | 19 | 0 | 0 / 8 / 158 | 86% | 1,072 | 60,848 | - | 0% | 94% |
| `cloudflare/clef-omni` | 9 | 74% | 21 | 0 | 1 / 4 / 389 | 83% | 500 | 110,026 | - | 25% | 94% |
| `openrouter` Jev | 9 | 78% | 18 | 0 | 4 / 6 / 384 | 81% | 436 | 82,282 | $0.0065 | 50% | 96% |
| `baseten/elephant-1` | 8 | 75% | 12 | 1 | 8 / 9 / 149 | 77% | 564 | 54,471 | $0.0038 | 50% | 98% |
| `baseten/joey-1` | 8 | 54% | 4 | 86 | 101 / 17 / 48 | 41% | 448 | 54,471 | $0.0011 | 50% | 23% |
| `baseten/mammoth-1` | 8 | 75% | 13 | 0 | 6 / 1 / 159 | 80% | 657 | 54,471 | $0.0110 | 50% | 98% |
| `inception/mercury-decide` | 9 | 75% | 16 | 3 | 9 / 0 / 385 | 81% | 808 | 86,157 | $0.0082 | 25% | 98% |
| `jaredpalmer/kev-4b` | 8 | 72% | 15 | 0 | 4 / 2 / 160 | 81% | 1,082 | 26,318 | $0.0026 | 25% | 94% |
| `liquid/d1` | 9 | 74% | 19 | 1 | 4 / 11 / 379 | 79% | 737 | 84,640 | $0.0090 | 25% | 96% |
| `liquid/d1-ultra` | 9 | 81% | 14 | 0 | 8 / 3 / 383 | 77% | 749 | 84,640 | $0.0189 | 75% | 96% |
| `liquid/d1.1` | 9 | 74% | 15 | 4 | 11 / 7 / 376 | 78% | 711 | 84,640 | $0.0090 | 25% | 94% |
| `microsoft/microsoft-decision-1` | 9 | 73% | 17 | 1 | 6 / 15 / 373 | 84% | 700 | 71,651 | $0.0147 | 0% | 98% |
| `nace-ai/drex-max` | 8 | 80% | 8 | 0 | 11 / 0 / 155 | 75% | 1,325 | 53,545 | $0.0158 | 75% | 100% |
| `nace-ai/drex-v1.5` | 9 | 71% | 21 | 0 | 1 / 12 / 381 | 86% | 915 | 73,543 | $0.0151 | 0% | 96% |
| `nace-ai/drex-v2.0` | 8 | 72% | 16 | 1 | 4 / 2 / 160 | 81% | 946 | 50,260 | $0.0164 | 25% | 94% |
| `respan/span-02` | 9 | 71% | 21 | 0 | 1 / 3 / 390 | 87% | 1,659 | 3,138,529 | $0.1320 | 0% | 96% |
| `togethercomputer/tev1-4b-experimental` | 4 | 44% | 9 | 0 | 0 / 6 / 11 | 86% | 796 | 30,920 | $0.0013 | 0% | - |
| `upstage/solar-decide` | 3 | 59% | 6 | 0 | 2 / 5 / 8 | 56% | 12,904 | 36,916 | $0.0018 | 50% | - |
| `upstage/solar-decide-flash` | 9 | 77% | 14 | 10 | 18 / 215 / 161 | 48% | 2,602 | 1,901,038 | $0.5947 | 100% | 92% |
| `codiv/openjev-latest` | 8 | 74% | 12 | 13 | 20 / 50 / 96 | 66% | 1,246 | 294,995 | - | 75% | 79% |
| `perplexity/pplx-decider-v1.1-27b` | 8 | 76% | 14 | 0 | 5 / 0 / 161 | 80% | 446 | 40,365 | - | 50% | 94% |
| `decisions-api-dev/jev-latest` | 3 | 56% | 5 | 0 | 2 / 3 / 7 | 70% | 1,833 | 4,545 | - | 50% | - |
| `decisions-api-dev/typesafe/jev-1.14` | 2 | 55% | 3 | 0 | 0 / 1 / 6 | 88% | 1,900 | 2,938 | - | - | - |
| `decisionapi-net/jev-latest` | 0 | - | - | - | - | - | - | - | - | - | - |
| `openai/gpt-6-luna` | 9 | 71% | 22 | 0 | 0 / 63 / 331 | 80% | 540 | 226,802 | - | 0% | 94% |

What the table says, read with the caveat the report prints:

- The wording change moved the mature routes from 61% to 71-79% agreement
  and from "keeps nothing" to a few keeps and more cuts, but a call the
  reference keeps still mostly lands on `truncate` (the call stays, the
  result is cut to its head): the result question scores a median of 0.20
  on those calls. `clef-flash` and GPT-6 Luna still keep nothing. Whether a
  truncated read of a file still on disk is harmful is the next label
  question; the metric counts it as `lossy` now.
- The generated sessions, whose labels keep three calls of 20 to 53 and
  allow dropping the rest, score 92-100% on nearly every route: they
  measure that a model drops what it may, not that it keeps what it must.
  `joey-1`, which keeps 101 of its 166 judged calls, scores 23% there;
  the `degenerate` mark is for a route that keeps all or none, and the
  routes it marks in this run are `clef-flash`, GPT-6 Luna, `tev1` and
  one `decisions-api-dev` row, which kept nothing.
- `session-230` (230 calls, 104,000 state tokens) does not fit the state
  budget of `clef-flash`, Baseten, `kev-4b` and `perplexity` (about 17,250
  tokens are left after every reduction) and would take 29 requests on
  the two Nace models with their 16-question cap, so those routes refuse
  it before sending; Codiv did not answer it within 30 seconds; TypeSafe
  and Clef judged it with the state cut, and OpenAI, whose budget is
  200,000 tokens, took it whole.
- `tev1-4b-experimental` counts the state once per question: at 32
  questions it refused two scenarios ("Tev1 sends state once per question;
  the prompts for 32 questions exceed the 1048576-byte limit") and its
  counts on three were read as cuts. `solar-decide` missed the 30-second
  deadline on five scenarios and its count on a sixth was read as a cut
  (median 12.9 s where it answered). Since this run
  `OPENROUTER_MODEL_LIMITS` asks both at most 8 questions a request and
  counts the state of both once a question.
- `decisions-api-dev` answered five compactions before its credits ran
  out; `decisionapi-net` has none (HTTP 402 on every request). Neither row
  measures the model.

**What a session looks like before `/compact`.** The generated scenarios
take their shape from 268 compactions in this machine's Claude Code
transcripts (main chain between compaction boundaries; two projects;
measured 2026-11-03; statistics only, no text), in `bench/shape.ts`:

| Measure (median; p10-p90) | ai-gateway (167) | ganja-code (101) |
| --- | --- | --- |
| tool calls before a compaction | 55 (2-228) | 22 (4-348) |
| assistant text per call, chars | 116 | 56 |
| tool input JSON per segment, chars | 80,087 | 33,566 |
| tool result, chars | 1,074 (p90 6,232) | 629 (p90 6,382) |
| tools, most used | Bash, SendMessage, Agent, Read, Write, Edit | Bash, Edit, SendMessage, Read, Agent, Write, Grep |
| context at compaction, tokens | 744k (345k-868k) | 191k (166k-878k) |

A real pre-compact state is dominated by tool inputs (long Bash commands,
heredocs, message bodies), with a short assistant note per call and short
results; the six hand-written scenarios have the opposite shape (long
prose, tiny inputs, three tools), which is why the generated ones exist.

Of the twenty OpenRouter-only models the first run tried, four are not
System One endpoints for this mod (Respan `span-01`, `span-01-lite`,
`span-01-lite:free` take a string or `{input, output}` messages; ScaleDown
`classify-1` takes `{text, document, document_mime_type}`; HTTP 400 on
every request) and left the catalogue; the question caps and the
state-per-question flags of the others came from that run and are in
`OPENROUTER_MODEL_LIMITS`.

The whole-state dry run of 08:56 JST the same day, which sent nothing,
measured the state in the first request of the `prose-60` scenario (then
named `large`) on each route. Whole, that state is 80,888 bytes, about
23,400 estimated tokens. A route's state is cut when it is smaller than
that:

| Route | State bytes | Estimated tokens | Questions | Cut |
| --- | --- | --- | --- | --- |
| `typesafe` (both models) | 80,888 | 23,387 | 112 | no |
| `openrouter` Jev | 20,351 | 8,340 | 32 | yes |
| `cloudflare` `clef`, `clef-omni` | 80,888 | 23,387 | 64 | no |
| `cloudflare` `clef-flash` | 42,551 | 13,907 | 64 | yes |
| `codiv` | 80,888 | 23,387 | 100 | no |
| `perplexity` | 26,456 | 9,884 | 62 | yes |
| `decisions-api-dev`, `decisionapi-net` | 25,901 | 9,741 | 8 | yes |
| `openai` | 80,888 | 23,387 | 112 | no |
| OpenRouter-only, Baseten | 43,661 | 14,187 | 32 | yes |
| OpenRouter-only, `kev-4b` | 13,526 | 6,010 | 32 | yes |
| OpenRouter-only, every other model | 80,888 | 23,387 | 58 | no |

A dry run sees only the first request of a compaction; the request counts
and the totals above come from the real runs.

#### Wordings

`--questions <name>` asks in a wording from `bench/wordings.ts`, the two
questions and the state's context together, in place of the mod's.
`current`, the default, is what the mod sends; a test holds it equal to
the mod's strings byte for byte. `legacy` is the mod's wording until
2026-11-03, which dropped nearly every call. `call-need` and
`result-exact` are the steps between the two: `call-need` rewrites the
call question ("Will the assistant need the fact that it ran ..." in place
of "Does the assistant still need to know that it made ..."),
`result-exact` also the result question ("the exact output ... for the
next step of the goal, rather than a summary or a fresh run" in place of
"word for word ... running the tool again would not bring it back"), and
`current` also the context (the sentence that the assistant can run any
tool again removed, and the goal tied to the newest prompt). A real run in
a wording other than `current` names it in the planned line and in the
report's caveat; a dry run prints neither.

Measured on 2026-11-03, 10:40 to 10:49 JST (lead, keys in a subshell, 88
compactions per wording): eight scenarios (the six hand-written ones,
`session-22` and `session-55`) on TypeSafe's two models, Cloudflare's
three, OpenAI, Perplexity, Codiv, and OpenRouter's `liquid/d1.1`,
`baseten/mammoth-1` and `kev-4b`, one repeat. The rows carry the names
`--questions` takes now; at the time of the run, `legacy` was still named
`current` and `current` was named `no-rerun`.

| Wording | Mean agreement | Harmful drops | Missed reductions | Kept / judged | keep-labelled calls, median P(call) / P(result) | drop-labelled, median P(call) / P(result) | `all-needed` on mature routes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `legacy` | 67% | 192 | 34 | 47 / 1,750 | 0.26 / 0.10 | 0.12 / 0.08 | 0% on all seven |
| `call-need` | 68% | 195 | 27 | 41 / 1,826 | 0.39 / 0.11 | 0.13 / 0.08 | 0% on all seven |
| `result-exact` | 71% | 176 | 18 | 51 / 1,826 | 0.41 / 0.20 | 0.14 / 0.06 | 0-75% (perplexity 75, clef 25, typesafe 25) |
| `current` | **73%** | **162** | **18** | **65 / 1,826** | 0.45 / 0.20 | 0.14 / 0.06 | 0-50% (typesafe 50, clef 50, perplexity 50, clef-flash 0, openai 0) |

`current` became the mod's wording on these figures: the highest
agreement, the fewest harmful drops and missed reductions, and never worse
than `legacy` on any route. It keeps the labelled classes apart: calls
labelled `keep` move from 0.26 to 0.45 on the call question while calls
labelled `drop` stay at 0.14. The target set before the run, `all-needed`
at 80% agreement or more on TypeSafe, every Cloudflare model, OpenAI and
Perplexity, was not met: it reaches 50% on TypeSafe and Clef and 0% on
Clef-flash and OpenAI, because the result question still scores a median
of 0.20 on calls the labels keep, so those calls land on `truncate` (the
call kept, the head of its result) rather than `keep`. That is better than
`legacy`'s `drop`, and the metric counts it as a lossy cut all the
same; whether a cut Read is harmful when the file can be read again is a
question for the labels, and putting the head of each result into the
state is the next change to the wording to measure.

#### Result heads

`--state head:<n>` has the state show the start of each call's output.
The note in place of the output becomes `ok, 1000 characters; first 300:
<the first 300 characters>`, or `ok, 120 characters, shown whole: <the
output>` when the output is no longer than n; a head never ends on half a
surrogate pair, so it can be one character shorter than n. The state's
context then says that the output "is shown in part: `result` says whether
it succeeded, how long it was, and how it starts" instead of that it "is
not shown". The other wordings describe a state without heads, so
`--state head:<n>` with a `--questions` other than `current` is a usage
error. A real run with heads names them in the report's caveat, and the
`--out` JSON records the flag as `flags.state`.

The heads are the first detail the state gives up. When the state with
them is over its budget, every head is dropped at once and the compaction
reports the stage `result heads dropped`, between `whole` and `inputs
shortened`. The context then goes back to saying the output is not shown,
so a state whose heads were dropped is byte for byte the one built without
heads, context included, and so is every later stage. A dry run prints no
stage: against the `--state none` dry run, a row is larger where the heads
were kept and equal where they were dropped or the state was held at its
budget anyway, and a dropped row reads `cut` `yes` because the whole state
it is compared with carries the heads. The real run's tables and
`outcome.stage` name the stage.

`--state none` is what every compaction sends: `DEFAULT_RESULT_HEAD` in
`hooks/state.ts` is 0, and a compaction shows no output. It becomes 300
only if a comparison of `--state none` with `--state head:300` on the six
hand-written scenarios (`fix-test`, `exploration`, `retry`,
`long-output`, `all-needed`, `prose-60`) over ten routes meets all three
conditions below, fixed before the runs. The seven mature routes are
`typesafe/jev-latest`, `typesafe/jev-1.14.0`, `cloudflare/clef`,
`cloudflare/clef-flash`, `cloudflare/clef-omni`, `openai/gpt-6-luna` and
`perplexity/pplx-decider-v1.1-27b`; the ten are those seven and
`codiv/openjev-latest`, `openrouter/~typesafe/jev-latest` and
`openrouter/liquid/d1-ultra`.

1. At `head:300`, `all-needed` agreement is at least 80% on each of the
   seven mature routes, counted on the records whose stage kept the heads
   (`whole`).
2. At `head:300`, the harmful drops are not above those of the `none` arm
   on any of the ten routes.
3. The median increase of `stateTokens` from `none` to `head:300`, paired
   by route and scenario over the six scenarios, is at most 2,000 tokens.

Each route has one `all-needed` record per arm, so a mature route whose
`all-needed` record dropped the heads has nothing to count for the first
condition, which is then not met for it. Such a route, and any mature
route that dropped the heads on half or more of its six records, gets a
third arm at `--state head:120` before the rule is read. Unless all three
conditions hold, the default stays 0 and the bench keeps the flag.

The runner's own tests use stubs for every `fetch` and never reach a
network:

```sh
bun test scripts/decision-compaction-bench.test.ts
```

One of them, `recount of the saved run 2`, reads the second run's JSON
from `.omc/bench/run2-current-wording.json`, a local file that is not
tracked, and checks that the recount gives back every record's agreement
and missed reductions and splits its harmful drops into 257 drops and 126
cuts. Without that file it fails and names the path; it is not skipped.

A hot reload of the mod while a compaction is running cancels the mod's
pending waits, the deadline's timer among them, so that compaction's
30-second bound does not hold across the reload. This matters only while
the mod is being developed.

#### Follow-ups

- Whether a cut of a result that can be read again (a `Read` of a file
  still on disk) is harmful at all is a question for the labels, not yet
  settled: the labels still say `keep` alone on such calls, and the bench
  counts their cut as `lossy`. `lo1`, the `pnpm audit` error result, is the
  one call labelled `keep` alone on an error result, and is to be reviewed
  with it.

## Acknowledgements

The algorithm follows the design of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT); the code here is an independent implementation.

## License

[Apache-2.0](../../LICENSE).
