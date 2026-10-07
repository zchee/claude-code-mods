# Everything a Claude Code mod can extend

English | [日本語](mods-extension-features.ja.md)

Researched 2026-10-07. Sources: the 10 pages of the official mods documentation (written as of v2.1.290), and the type declarations `claude-code/index.d.ts` (15,776 lines) that the installed Claude Code 2.1.292 writes.

## Summary

A mod is a plugin that runs JavaScript or TypeScript event handlers (hooks) inside the Claude Code process. Its extension points fall into four groups:

1. **Events**: 46 named events in the documentation, 33 `classic.*` events that mirror the settings hook events, and every mods API call (such as `fs.read`). A hook observes an event, rewrites it, or answers it in Claude Code's place.
2. **The mods API** (`$`): 21 namespaces. They add commands, tools and subagent types, call a model, run timers, message other sessions, reach files, processes, HTTP and MCP, and play audio.
3. **Interface**: 15 render sites and 12 elements. A mod can add its own pane and a band above the prompt, and it can replace parts of Claude Code's own interface, such as the spinner, tool rows and the question dialog. It cannot change the permission prompt.
4. **Development and operations**: hot reload, generated type declarations, static analysis with `claude plugin validate`, tests with `claude plugin test`, and organization policy (load order, the built-in guard, policy mods).

The 2.1.292 type declarations also contain an event the documentation does not mention, `prompt.autocomplete`, which adds typeahead suggestions to the prompt box.

[Section 14](#14-apis-that-change-claude-codes-behavior-with-sample-code) lists the events and API calls that change Claude Code's behavior, arranged by what you want to change, with sample code for each.

### Sources

| Short name | URL |
| :- | :- |
| overview | https://code.claude.com/docs/en/plugins/mods/overview |
| create | https://code.claude.com/docs/en/plugins/mods/create |
| events | https://code.claude.com/docs/en/plugins/mods/events |
| api | https://code.claude.com/docs/en/plugins/mods/api |
| interface | https://code.claude.com/docs/en/plugins/mods/interface |
| gallery | https://code.claude.com/docs/en/plugins/mods/gallery |
| test | https://code.claude.com/docs/en/plugins/mods/test |
| troubleshoot | https://code.claude.com/docs/en/plugins/mods/troubleshoot |
| admin | https://code.claude.com/docs/en/plugins/mods/admin |
| reference | https://code.claude.com/docs/en/plugins/mods/reference |
| d.ts | The type declarations (2.1.292) that `claude --plugin-dir <mod>` writes to `<mod>/.claude-plugin/types/claude-code/index.d.ts`. Line numbers refer to this file. |

---

## 1. What a mod is, and how it differs from other extensions (overview)

A mod is a kind of plugin. A plugin becomes a mod when the `modules` key in its `hooks/hooks.json` points to a hooks module, a JS or TS file. Claude Code fires an event just before it acts, and a hook runs before that action.

| | Mod | Settings hook | Skill | MCP server |
| :- | :- | :- | :- | :- |
| What it is | Functions called inside the Claude Code process | A shell command, HTTP request or prompt run on a lifecycle event | A `SKILL.md` that Claude reads | An external process that gives Claude tools |
| What it can change | Tool calls, prompts, commands, turns, what the interface draws | Whether a tool call or prompt goes ahead, a call's arguments and result, context for Claude | What Claude knows and does | Which tools Claude has |
| Draws in the interface | Yes | No | No | No |
| Written in | JS / TS | Any script plus a `settings.json` entry | Markdown | Any language |

The documentation lists five things only a mod can do: draw an interface the user can operate, redraw Claude Code's own interface, step into a tool call or a model request (hold a call to ask the user, answer it without running the tool, send a request to another model), run a command at once without a Claude turn, and share variables between hooks.

### Where mods run

| Where Claude Code runs | Hooks run | What the mod draws appears |
| :- | :- | :- |
| `claude` in a terminal (including editor terminals and the JetBrains plugin) | Yes | Yes |
| The Desktop app's Code tab (except WSL sessions) | Yes | Yes, except terminal-only elements |
| A WSL session in the Desktop app | No (plugins are unavailable) | No |
| The VS Code extension's chat panel | Yes | No |
| `claude -p` and the Agent SDK | Yes | No |
| Remote Control (claude.ai or mobile) | Yes, in the session on your machine | In the terminal on your machine |
| A cloud session | Yes, for a plugin that reaches the cloud session | No |

Mods need v2.1.287 or later in the terminal, and v2.1.286 or later in the Desktop app's bundled copy.

### What a mod can reach (security)

A mod is not sandboxed and runs with the user's permissions. It can read and write files, start processes, make network requests, read environment variables and settings files (including API keys), see and rewrite every prompt and tool call, submit a prompt as the user, message other sessions, approve a tool call before the user is asked, and call a model on the user's plan or API key. Turning on sandboxing isolates only the Bash commands Claude runs; a process a mod starts runs outside it.

---

## 2. Files and the hook function (reference, create)

### Files

| File | Required | Contents |
| :- | :- | :- |
| `.claude-plugin/plugin.json` | Yes | The plugin manifest. Mods add no required fields. |
| `hooks/hooks.json` | Yes | `"modules": ["./register.js"]` (one path). Settings hooks can sit beside it under `hooks`. |
| The hooks module | Yes | An ES module that exports `register(on, options)`. Extensions: `.js .mjs .cjs .jsx .ts .mts .cts .tsx` |
| `types/index.d.ts` (named by `types` in the manifest) | When the mod uses `$.state` or adds a namespace to the API | `PluginState` declarations and the like |
| `*.test.ts` / `*.test.tsx` | No | Tests that `claude plugin test` runs |

There is no Node.js, bundler or build step; Claude Code loads `.js` and `.ts` files directly. The `options` argument of `register` holds the values of the manifest's `userConfig` fields, with defaults filled in.

### Hook arguments

Register a hook with `on(eventName, [matcher], async ($, e, next) => ...)`. The returned registration has `.catch(handler)` to attach an error handler.

| Argument | What it is |
| :- | :- |
| `$` | The mods API. Always write calls in full, namespace then method, as in `$.fs.read(...)` |
| `e` | The event input, deeply frozen plain data. To change it, pass a copy to `next` |
| `next(e)` | The next middleware stage: the following mods' hooks, then Claude Code's own behavior. Resolves to the result |
| `next.signal` | An `AbortSignal` that aborts when the event is abandoned (for example, the user interrupts) |
| `next.origin` | `{ plugin, tier }` of whoever fired the event. Claude Code itself is `{ plugin: 'engine', tier: 'core' }` |
| `next.budget` | The time limit: `ms` is the whole limit, `remainingMs` what's left |
| `next.to(e, tier)` | Skips to a later tier (`append`, `builtin`, `core`). Only mods in `prependPlugins` or `appendPlugins` can call it |
| `next.error`, `next.called` | In a `.catch` handler only. `kind` is `throw` or `timeout` |

Hooks on `turn.step` and `process.spawn` are async generators; all other hooks are async functions.

---

## 3. Events (events, reference)

### What a hook does with an event

- **Observe**: do your work and `return next(e)`. To act afterwards, `const r = await next(e)`, do your work, and return `r`.
- **Rewrite**: pass a copy such as `next({ ...e, text: ... })`. You can also return a changed copy of the result.
- **Answer**: return a result without calling `next`. Later mods and Claude Code's own behavior don't run.

### Matchers

The second argument to `on` is compared with the event's fields, and the hook runs only when every field matches. A field can be a string, an array (any value), or a regular expression.

```javascript
on('tool.call', { tool: 'Bash' }, hook)
on('tool.call', { tool: ['Edit', 'Write'] }, hook)
on('tool.call', { tool: /^mcp__github__/ }, hook)
```

Event names accept two wildcards: `'classic.*'` (every settings hook event) and `'*'` (every event except telemetry). Registering the same event twice without a matcher makes the module fail to load.

### Tools

| Event | Fires when | A hook can return |
| :- | :- | :- |
| `tool.call` | A tool is about to run (including subagent calls and MCP tools) | `next(e)`, `{ deny: reason }`, `{ result }` |
| `tool.check` | Claude Code decides whether the call may run, after `tool.call` and `PreToolUse`. `next(e)` resolves to the decision the rules, permission mode and hooks reached | `{ decision }` (`allow` / `ask` / `deny`) |
| `tool.describe` | A tool's description is first sent to Claude | `{ description }`, with `isDeferred: true` to put it behind tool search or `false` to load it upfront |

In `tool.call` a hook can:

- pass changed arguments to `next`;
- see `isError` and call `next(e)` again to retry;
- return `{ result }` so the tool never runs (and no permission prompt appears);
- `await $.ui.ask(...)` to hold the call while the user picks an option.

Time spent waiting in `$.ui.ask` does not count against the hook's time limit. Time spent awaiting a promise of your own does, and a hook that times out is skipped, so the held command runs.

### Prompts and what Claude reads

| Event | Fires when | A hook can return |
| :- | :- | :- |
| `prompt.submit` | A prompt is submitted | `next({...e, text})` (rewrite, shown in the transcript), `next({...e, context})` (text only Claude reads), `{ drop: reason }` |
| `prompt.fill` / `prompt.suggest` | Text is about to go into the prompt box as a draft or a dim suggestion | `next(e)` with changed text |
| `prompt.edit` | The user edits the prompt box (50 ms time limit) | `next(e)` |
| `prompt.compose` | A system prompt is rendered | `{ sections }`, a list of `{ id, text, scope }` in send order |
| `prompt.section` | Once per named section of the system prompt | `{ text }`, or `{ text: null }` to omit it |
| `prompt.context` | Once per conversation, for the context sent with the first message | `{ blocks }` |
| `prompt.attachment` | Claude Code adds a message of its own, such as a reminder. `e.type` is the kind, `e.detail` the facts behind it | `{ text }`, or `{ text: null }` to omit it |
| `prompt.mention` | Claude Code is about to read an @-mentioned file (v2.1.290 or later) | `next({...e, path})` to read another file, `{ deny }` |
| `skill.prompt` | A skill's text is expanded | `{ text }` |
| `attribution.text` | Commit or pull request attribution text is composed | `{ text }` |
| `prompt.autocomplete` | **Not in the documentation (d.ts:4123, 8173).** Fires while the user types, for the token at the cursor | `{ suggestions: [{ text, label?, description? }] }`, added below Claude Code's own suggestions |

Text from these hooks that changes between requests invalidates the prompt cache.

### Commands and configuration

| Event | Fires when | A hook can return |
| :- | :- | :- |
| `command.run` | A command is about to run | `{ text }` (printed, and Claude reads it), `{}` (prints nothing), `next(e)` |
| `command.describe` | Once per command, for the command list | `{ description, argumentHint, isHidden }` |
| `config.set` | A `/config` row is about to change | `next({...e, value})`, `{ deny }` |
| `config.describe` | Once per `/config` row | `{ label, description, isHidden }` |

### Turns

| Event | Fires when | What a hook can do |
| :- | :- | :- |
| `turn.start` | A turn begins | Observe. `e.turnId` links it to the other two events |
| `turn.step` | One request is about to go to the model (a turn with tool calls has several). `e.agentId` is set for a subagent | As an async generator, `yield* next(e)`. `next({...e, model})` sends it to another model, `next({...e, effort})`, or answer without calling the model |
| `turn.complete` | A turn ended (`e.isAborted` when interrupted). `e.answer`, `e.durationMs`, `e.usage` | Observe, or return `{ text }` to show a line under the answer |

`result.usage` from `turn.step` holds `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and the model that answered.

### Session

| Event | Fires when | A hook can return |
| :- | :- | :- |
| `session.start` | Once per mod, before the first prompt, and again after that mod reloads. Not after `/clear`, `/resume` or `/branch` | `next(e)` |
| `session.end` | The session ends, or `/clear`, `/resume` or `/branch` runs. `e.reason` is `clear`, `resume`, `logout`, `prompt_input_exit` or `other` | `next(e)` |
| `session.compact` | The conversation is about to be compacted | `{ skip: reason }` to stop it |
| `session.receive` | A message arrives from another agent or session, before Claude reads it | `{ consumed: reason }` to keep it from Claude |
| `session.send` | A message is about to leave (from the SendMessage tool or a mod) | `{ isDelivered: false, reason }` |
| `session.append` | Each row the conversation keeps (prompt, response block, tool result, notice), before it's stored | `next({...e, message})` to rewrite its `content` |
| `session.attach` / `session.detach` | Another app connects to or disconnects from the session | `next(e)` |
| `session.measure` | After each turn, and when a plan limit's percent used changes | `next(e)` |

### Subagents

| Event | Fires when | A hook can return |
| :- | :- | :- |
| `agent.offer` | A subagent type is offered to Claude | `{ isOffered: false }` to withhold it |
| `agent.spawn` | A subagent or an agent team teammate is about to start (`e.isTeammate` for a teammate) | `next({...e, model})` to choose its model, `{ deny }` |

### Interface

| Event | Fires when |
| :- | :- |
| `ui.render` | A render site is about to be drawn |
| `ui.resolve` | Mods load, once per app, render site and mod. The result is the element table `$.ui.resolve(e)` reads |
| `ui.press` / `ui.input` / `ui.select` | A `Button`, `Input` or `Select` a mod drew is used (other mods' hooks run before the drawing mod's callback) |
| `ui.focus` / `ui.scroll` | Focus or a scroll position is about to change |
| `ui.close` | A pane is about to close. `e.origin.kind` is `plugin`, `person` or `unload` |
| `ui.message` | A `Client` element posts data to its mod |
| `ui.fault` | A `Client` element failed to load, draw or run (v2.1.289 or later) |

### Other mods

| Event | Fires when | A hook can return |
| :- | :- | :- |
| `plugin.register` | Another hooks module is about to load. `e.uses` lists its events, API calls, environment variables and state | `{ refuse: reason }` to keep it from loading |
| `engine.create` | The mods API is being built for a mod | A changed API that adds a namespace. A mod outside the `user` tier can also withhold one |

### Telemetry

`telemetry.log` and `telemetry.mark` require the matcher `{ to: 'collector' }`; without it the mod fails `claude plugin validate`. `*` doesn't match them. They return `next(e)` or `{ deny }`.

### Settings hook events (`classic.*`)

Each settings-file hook event is also an event named `classic.<EventName>`, and `e` is the JSON a settings hook reads on stdin. The type declarations list these 33:

`ConfigChange CwdChanged DirectoryAdded Elicitation ElicitationResult FileChanged InstructionsLoaded MessageDisplay Notification PermissionDenied PermissionRequest PostCompact PostModelSwitch PostToolBatch PostToolUse PostToolUseFailure PreCompact PreModelSwitch PreToolUse SessionEnd SessionStart Setup Stop StopFailure SubagentStart SubagentStop TaskCompleted TaskCreated TeammateIdle UserPromptExpansion UserPromptSubmit WorktreeCreate WorktreeRemove`

According to the type declarations (d.ts:1224), they fire even when no settings hook is configured. Only `classic.PreToolUse` has a different shape: its `e` is the tool call envelope (d.ts:1236).

To load a value again after `/clear`, `/resume` or `/branch`, hook `classic.SessionStart` with `{ source: ['clear', 'resume', 'fork'] }` (interface).

### Mods API calls as events

Every mods API method is also an event (`fs.read`, `model.complete`, `ui.open`, ...). A mod earlier in the chain can observe, rewrite, refuse (`{ deny }`) or answer (`{ value }`) the calls of the mods after it. This is how an organization restricts what mods do with a policy mod.

One exception: `$.ui.ask` has no event of its own. It is implemented as a `tool.call` of the `AskUserQuestion` tool (d.ts:2420, and the stub table on the test page). To intercept `$.ui.ask`, hook `tool.call` with `{ tool: 'AskUserQuestion' }`.

### The order mods run in

Hooks on the same event form one middleware chain, and the first mod is outermost. It sees the event first and the result last, so it decides whether the later mods run.

1. The built-in guard `sec-default@builtin` (where it loads), mods in `prependPlugins`, and other organization mods not in `appendPlugins`
2. Mods the user installed (a mod runs before the mods it lists under `dependencies`)
3. Mods in `appendPlugins`
4. Other mods built into Claude Code

Within one module, hooks run in the order `register` called `on`.

Where settings `PreToolUse` hooks sit:

- `PreToolUse` hooks from managed settings run before every mod's `tool.call` hook, and a block from one is final. If a mod rewrites the call, they run again on the rewritten call (admin).
- `PreToolUse` hooks from other settings files and from plugins run after the last mod calls `next`. A mod that answers without calling `next` keeps them from running.
- `tool.check` fires after that, so it can approve a call that a hook in the second group blocked.

### When a hook fails

When a hook without `.catch` throws, times out or returns a result of the wrong shape: if it failed before calling `next`, it is skipped and the next handler runs in its place (fail open); if it failed after `next` resolved, that result stands. To make a blocking hook fail closed, return `{ deny }` from a `.catch` handler. A `.catch` handler has a 1-second time limit.

---

## 4. The mods API (api, reference, d.ts)

The "Coverage" column says whether a guide page shows the method in use ("guide") or the reference table only names it ("name only"). Descriptions of name-only methods come from the comments in the type declarations.

| Namespace | Methods | Coverage | Notes |
| :- | :- | :- | :- |
| `$.plugin` | `name`, `root` | name only | This plugin's name and directory |
| `$.ui` | `resolve` `invalidate` `open` `close` `toast` `status` `log` `blit` | guide | Drawing (section 5) |
| `$.ui` | `ask` | guide | Asks in the AskUserQuestion dialog and resolves to the chosen label. Rejects when dismissed and under `-p` |
| `$.ui` | `panes` `focus` `scroll` `copy` `selection` `notice` | name only | d.ts:2336-2558. `panes` lists this mod's open panes (still visible after a reload); `focus` / `scroll` work like the DOM's `focus()` / `scrollIntoView`; `copy` writes to the clipboard; `selection` returns the text and row the user last selected with the mouse; `notice` shows one line under an open dialog |
| `$.command` | `register` `run` `list` | guide (`register`) | `immediate: true` lets the command run while Claude is working. A built-in command's name throws |
| `$.tool` | `register` `call` `check` `list` | guide (`register`) | Claude sees the tool as `mcp__<plugin>__<name>`. Its calls are handled in a `tool.call` hook |
| `$.agent` | `register` `spawn` `list` | name only | d.ts:3185. `register` defines a subagent type named `<plugin>:<name>` (the same fields as an agent file); `spawn` starts one |
| `$.model` | `complete` | guide | One prompt with no conversation history. An API failure doesn't reject; read `isAnswered` / `reason`. `maxTokens` defaults to 1024 |
| `$.model` | `fork` | guide (brief) | Asks one question over the current conversation with the same model and system prompt, so the prompt cache serves most of it. Every tool is denied (d.ts:2609) |
| `$.model` | `classify` | name only | d.ts:2628. Picks one of `labels` for `text`; `undefined` when the answer names none |
| `$.prompt` | `submit` | guide | Starts a turn once the session is idle. By default the text follows a sentence naming the mod as sender; `asUser: true` sends it as the user's own words |
| `$.prompt` | `read` `fill` `suggest` `compose` | name only | `read` returns the draft and cursor; `fill` replaces, appends to, or inserts into the draft (d.ts:2932, 2946) |
| `$.turn` | `abort` | name only | d.ts:2903. Cancels the running turn whose id `turn.start` gave this mod, stopping its running tools |
| `$.session` | `send` `messages` `usage` | guide | `send` uses the same delivery as the SendMessage tool. `messages()` returns the newest 4,096 entries. `usage()` returns context use, rate limits and cost |
| `$.session` | `cwd` `root` `model` `turns` `id` `repo` `surfaces` `version` `compact` `append` `authorize` | name only | `authorize` (d.ts:2885) keeps the Anthropic credential on the host and returns only an opaque handle, usable with `$.http.fetch(url, { auth })` for a first-party host. `surface` (singular) is deprecated in the types |
| `$.config` | `list` `set` | name only | Read and change `/config` rows |
| `$.settings` | `read` | guide | The merged settings, or one source's with `{ source }` |
| `$.env` | `get` `set` | guide | Write the variable name as a string literal. `set` also applies to every command and MCP server Claude Code starts afterwards |
| `$.fs` | `read` `write` `list` `exists` `stat` | guide | Relative paths resolve against the working directory. `list` isn't recursive. `write` isn't atomic. 4 MiB per file |
| `$.fs` | `ancestors` | name only | d.ts:3314. Reads named instruction files in every directory above, the way Claude Code reads CLAUDE.md, with `@include`s expanded |
| `$.store` | `get` `set` `delete` `keys` | guide | A JSON key-value store shared by every session on the machine. 4 MiB in total |
| `$.state` | `get` `set` (with `atom` `read` `update` `derive` `memberOf` imported from `claude-code`) | guide | Reactive state (section 6) |
| `$.clock` | `now` `sleep` `after` `every` | guide | Replaces `setTimeout` / `setInterval`. Timers stop when the module reloads |
| `$.http` | `fetch` | guide | Resolves to `{ status, ok, headers, text }`. Organization network policy applies |
| `$.process` | `run` `spawn` | guide | Starts an argument vector with no shell. `run`: 30 seconds by default, 10 minutes at most. `spawn` streams output, and leaving the loop kills the child |
| `$.mcp` | `call` `connect` | name only | `connect` connects only MCP servers this plugin's own manifest lists |
| `$.audio` | `play` `speak` | name only | d.ts:2649, 2663. Uses `afplay` and `say` on macOS. Plays nothing in a Linux or Windows terminal |
| `$.telemetry` | `log` `mark` | name only | A record is sent only when Claude Code or a built-in mod makes the call |

A hooks module has no Node.js APIs and no `setTimeout`; everything outside the module goes through `$`. Standard web APIs such as `URL`, `TextEncoder`, `AbortController` and `crypto.subtle` are available.

### Showing something without starting a turn

| Call | What the user sees |
| :- | :- |
| `$.ui.status(text)` | One line under the prompt that stays until changed, starting with `⚠ <mod name>:` |
| `$.ui.toast(text)` | A toast at the top right, 4 seconds by default (`timeoutMs` changes it) |
| `$.ui.log(text)` | A dim line in the transcript that Claude doesn't read. With `{ to: 'debug' }` it goes to the debug log |

---

## 5. Drawing in the interface (interface, gallery, reference)

A `ui.render` hook returns an element tree, and Claude Code draws it in the terminal or the Desktop app. Get the elements from `$.ui.resolve(e)`. A `.tsx` or `.jsx` module can write the tree as JSX.

### Render sites

| Site | What it is | `e.props` | Rendered on |
| :- | :- | :- | :- |
| `Pane` | The mod's own pane: a sidebar in a wide fullscreen terminal, a framed region above the prompt otherwise | `title` `isFocused` `bodyColumns` `placement` `scroll` `view` | Terminal / Desktop |
| `AbovePrompt` | The band directly above the prompt. Always present and shared by every mod | `hasSurvey` `isWorking` `maxRows` `bodyColumns` `scroll` `view` | Terminal / Desktop |
| `UserMessage` / `AssistantMessage` | A message in the transcript | Text, origin and more | Terminal / Desktop |
| `ToolUse` / `ToolResult` / `ToolGroup` | A tool call's row, its result, a collapsed group | Tool name, input, result | Terminal / Desktop |
| `CommandOutput` | The row a command printed | `command` `text` | Terminal / Desktop |
| `AskUserQuestion` | The dialog Claude asks questions in | Question and options | Terminal / Desktop |
| `Spinner` | The line that animates while Claude works | `word` `message` `suffix` `mode` | Terminal / Desktop |
| `SessionMode` | Mode labels in the footer | `modes` | Terminal / Desktop |
| `PromptHint` | The hint line under the prompt | `isDraft` `isWorking` `hint` | Terminal / Desktop |
| `ToolProgress` | A running tool's progress line | `kind` | Terminal only |
| `TurnDuration` | The line that closes a turn | `word` `durationMs` | Terminal only |
| `InfoNotice` | Status lines under the logo | `text` `command` | Terminal only |

At a site Claude Code already draws, a hook can:

- change a detail with `next({...e, props: {...}})`;
- replace the drawing by returning a tree without calling `next`;
- leave it alone with `next(e)`;
- put the `{ type: 'engine', ref }` that `await next(e)` returns in a `Box` beside its own elements.

A tree for `AskUserQuestion` must contain that reference exactly once, with your elements above it; otherwise Claude Code draws its own dialog. **The permission prompt is not a render site, so no mod can change it.**

In the band (`AbovePrompt`), a returned tree replaces what later mods draw. To keep theirs, include the result of `await next(e)` among your children.

### Elements

| Element | Main props | Terminal | Desktop |
| :- | :- | :-: | :-: |
| `Box` | Flex layout, `gap` `padding` `margin` `width` `height` `borderStyle` `backgroundColor` `position` `hover` | ✓ | ✓ |
| `Text` | `color` `backgroundColor` `bold` `italic` `underline` `strikethrough` `dimColor` `inverse` `wrap` | ✓ | ✓ |
| `Button` | `key` `label` `onPress` `hotkey` `plain` `dimColor` `autoFocus` `action` | ✓ | ✓ |
| `Link` | `href` `label` | ✓ | ✓ |
| `Code` | `source`, `language` or `path`, `startLine`; `format: 'diff'` draws a diff with word-level highlights | ✓ | ✓ |
| `Markdown` | `text` (not `children`), `onLinkPress`, `pressableLinks` | ✓ | ✓ |
| `Input` | `key` `label` `placeholder` `value` `submitLabel` `onSubmit` `onInput` `autoFocus` | ✓ | ✓ |
| `Select` | `key` `label` `options` `value` `onSelect` `autoFocus` | ✓ | ✓ |
| `Client` | `module` `key`. A region drawn by a second file, for animation and pointer input. It gets no mods API and posts data as `ui.message` | ✓ | ✓ |
| `Svg` | An SVG document, up to 131,072 characters | | ✓ |
| `Raster` | A grid of colored character cells, up to 512 columns by 256 rows. `cells` is base64 of uint32 triples (code point, foreground, background) | ✓ | |
| `Image` | PNG or RGBA bytes up to 2 MiB, or a file path | ✓ | |

A tree with an element or prop the app doesn't have fails validation, and Claude Code draws its own version of the site. In a `--plugin-dir` session the transcript shows a `ui.render (Pane) refused: ...` line. `$.ui.blit` repaints a `Raster` or swaps an `Image` without running `ui.render` again (up to 120 a second accepted).

### Opening and placing a pane

Open with `$.ui.open({ id, title?, focus?, closeOnEscape?, holdToasts?, rows?, columns? })` and close with `$.ui.close({ id })`. `focus`, `closeOnEscape` and `holdToasts` accept only `true`; passing `false` throws. To set one conditionally, leave the field out.

- Opened by something the user did (a command or a button), the pane appears at any width.
- Opened by the mod on its own (a timer, a `turn.start` hook), it appears only in a terminal at least 144 columns wide, or 110 after the user has opened it once. Otherwise `$.ui.open` returns `isPlaced: false` with a `reason`.

### Keyboard

A mod never reads the keyboard itself. Keys reach its controls only while its pane or band has focus (digit hotkeys on the band are the exception). A pane gets focus when it opens with `focus: true` (granted only while the prompt is empty), when the user presses Ctrl+X then Tab, or when they click it.

| Key | What it does |
| :- | :- |
| Tab / Up / Down | Move between controls; scroll when the content doesn't fit |
| Enter | Press a button, submit an Input, pick in a Select |
| A hotkey (one digit or lowercase letter) | Press that button. While an Input has focus, keys go to the field |
| Page Up / Page Down / Home / End | Scroll |
| Ctrl+X then an arrow | Resize the pane |
| Ctrl+X then X | Close the pane |
| Esc | Return focus to the prompt (and close the pane with `closeOnEscape`) |

Tab and the arrow keys can't be bound to anything else. A `Button` whose `action` names one of Claude Code's keybinding actions is pressed by the user's binding for it, when that binding is a chord or a modified key.

### Redrawing

Claude Code runs `ui.render` again on its own only when a site's props change or the terminal's width changes. When the mod's own data changes, call `$.ui.invalidate('ui.render')`. Redraws are throttled to 10 a second (30 in the terminal for the visible pane, the expanded band and the hint line), and faster calls are coalesced. For periodic updates, start a `$.clock.every` timer in `session.start`.

---

## 6. Keeping state (interface)

| Keep it in | It lasts until | Use it for |
| :- | :- | :- |
| A module-level variable | The module reloads (on every save during development) | Values you can lose |
| `$.state` | The session ends, or `/clear`, `/resume` or `/branch` runs. Survives a reload | Values a drawing depends on. Writing one redraws the sites that read it |
| `$.store` | The mod deletes it, or no session uses the store for `cleanupPeriodDays`. A JSON file under `~/.claude/plugins/store/` | Settings, history, anything the user expects next time |

To use `$.state`, declare `declare module 'claude-code' { interface PluginState { '<plugin name>': {...} } }` in `types/index.d.ts` and point the manifest's `types` at it. The `plugin` and `key` of `atom({ plugin, key }, default)` must be string literals. A `ui.render` hook can only read state; write it from a callback or another event's hook.

Every session shares `$.store`, and a `get` followed by a `set` isn't atomic. Give each item its own key, or read again right before you write, to make lost writes less likely.

---

## 7. Creating and developing a mod (create)

### Ask Claude to write it

Claude uses the built-in `plugin-authoring` skill. Claude loads it when you ask for a mod, and `/plugin-authoring` loads it by hand.

- The mod is written to `~/.claude/dev-mods/<session id>/<mod name>/`. `~/.claude` is a protected path, so `default` and `acceptEdits` modes ask before each file.
- When the first file is saved, Claude Code asks whether to enable hot reloading. If you enable it, the mod loads when the turn ends and reloads at the end of each turn that changes it.
- It doesn't load where nobody can approve (`-p`, `dontAsk`), in an untrusted workspace, or under `--safe-mode`, `--bare`, `disableAllHooks` or an organization policy.
- The directory is deleted after `cleanupPeriodDays`; to keep the mod, copy it elsewhere and load it with `--plugin-dir`.

### Write it yourself

`claude --plugin-dir ./mod` loads the directory for one session. Saving a file hot-reloads the hooks module and runs `register` again (module variables reset). If a save breaks the module, "reload failed, the previous version stays loaded" appears and the last working version keeps running. Installed plugins are cached by version, so develop against `--plugin-dir`, not an installed copy.

### Generated type declarations

Loading with `--plugin-dir`, or a mod Claude writes, makes Claude Code write these files into `.claude-plugin/types/`:

| Path | What it declares |
| :- | :- |
| `claude-code/index.d.ts` | Every event's input and result, every API method, and the elements each surface draws, with a comment and example per method |
| `claude-code-tools/index.d.ts` | Built-in tools' inputs and results (checking `e.tool === 'Bash'` narrows `e`) |
| `claude-code-mcp/index.d.ts` | Inputs of the MCP tools connected the last time a file in the mod was saved |
| `<dependency name>/index.d.ts` | What each plugin under `dependencies` adds to the API |
| `tsconfig.json` | Compiler options for a hooks module. If the mod has no tsconfig, one that extends this is added at its root |

The documentation says to trust these files over the documentation when the two disagree.

### `claude plugin validate` and static-analysis rules

It prints `hooks:` (events with matchers), `calls:` (API calls), `env reads:/writes:` and `state reads:/writes:`. `--strict` treats warnings as errors and `--json` prints a machine-readable report. Claude Code refuses a module its analysis can't read.

- Write each call in full as `$.ns.method(...)`. Assigning `$` to a variable, destructuring it, or indexing it with a computed name fails (`$.ui is used as a value`).
- `$` can be passed only to a function declared at the top level of the same file (the `calls:` line shows `(via fn)`), not to a method, a function defined inside a hook, or an imported function. The exceptions are `read` / `update` for `$.state`.
- Event names in `on` must be string literals; variables and loops fail.
- Don't shadow `on` inside `register`.
- Import only relative files inside the plugin, plus `claude-code` (types and helpers). No `import()` and no `require`.
- A plugin name that looks like one of Anthropic's (such as one starting with `claude-`) fails validation.

---

## 8. Testing (test)

`claude plugin test [dir]` runs every `*.test.ts` / `*.test.tsx`. It needs no session, sign-in or network, and exits with status 1 on failure, so it works in CI. Tests import `{ expect, test, mock, tier }` from `claude-code/testing`.

- A test receives `($, on)`. `$` acts as Claude Code: `$.tool.call(...)`, `$.command.run(...)`, `$.prompt.submit`, `$.session.start`, `$.turn.complete` and `$.classic.*` fire the matching event through the mod.
- `on` registers stubs. A stub for an API call returns `{ value }` (or `{ deny }`); a stub for an event returns that event's result. Register every stub before the first call on `$`.
- `session.start` doesn't run on its own; fire it when a hook depends on it.
- A `ui.render` hook that returns `next(e)` needs a stub that returns an element as plain data.
- A `turn.step` stub is an async generator.
- `mock.clock(on)` returns a clock the test moves with `advance`, `set`, `settle` and `sleep`. `mock.store(on, entries)` and `mock.env(on, vars)` also exist.
- Test a drawing with `$.ui.mount({ ...site, surface })`; the handle's `press`, `input`, `select`, `find` and `unmount` address elements by `key`. This checks the tree and its validity, not how the app paints it.
- Test a policy mod with `tier('prepend')` and `test(name, { plugins: [inline mods] }, fn)`.
- `expect` has `toBe`, `toEqual`, `toMatch`, `toMatchObject`, `toContain`, `toBeDefined`, `toBeUndefined`, `toThrow` and `.not`. One test times out after 5 seconds by default.

---

## 9. Troubleshooting (troubleshoot)

A failing module or hook is skipped and the session continues, so a broken mod looks like one that does nothing.

- **Where messages go**: the transcript in a session that hot-reloads a plugin directory, the `--debug` log in other interactive sessions, stderr under `-p`.
- **Whether mods can load**: run `claude plugin test` in a directory with no mod. `no hooks module to load` means they can, `turned off here` means a setting blocks them, `turned off in this process` means Anthropic turned them off remotely.
- **Common refusals**: `disableAllHooks in managed settings`, `only managed plugins and built-in plugins run`, `--bare`, two plugins with the same name, a `userConfig` value that fails validation, top-level code that throws.
- **Built-in guard messages**: `allowManagedModsOnly`, `tried to lift a deny rule`, `deny rules ... could not be checked`.
- **At run time**: `hook skipped: threw/timeout/...`, `no command.run hook answered it`, `it crashed the hooks worker`. Installed mods share one worker thread, and a mod traced as stopping it is unloaded. After three crashes that can't be traced to one mod, every mod that isn't built in stays off until `/reload-plugins`.
- **Auto mode**: a hook that changes a call's input after the classifier reviewed it gets the call denied with `a hook changed this call's input after the model wrote it`.
- **Debug log**: a loaded module appears as `hooks module first-mod@inline loaded (worker, environment 2, tier user); events: ...`.

---

## 10. Organization management and security (admin)

### Defaults

- Mods are on. Users can install them from any marketplace their plugin settings allow, and load them with `--plugin-dir`.
- On a machine with managed settings, or for a user signed in with a Team or Enterprise plan, the built-in guard `sec-default@builtin` loads ahead of every mod a user installs. Users can't turn it off.
- The guard protects the input and decisions of managed hooks, the system prompt, managed CLAUDE.md and instructions, what mods read as settings, and the tools and descriptions of managed MCP servers. It adds no other restriction.
- Where the guard loads, a user's mod can't approve a call a `deny` rule refuses. This applies to Claude's tool calls only, not to a mod's own `$.fs` and `$.process` calls: with `Read(.env)` denied, `$.fs.read` still reads the file.
- A mod can override an `ask` rule and a block from a non-managed `PreToolUse` hook. In auto mode, a call a mod approves runs without a classifier check.
- Network policy covers `$.http.fetch`, but not a program the mod starts with `$.process.run`.

### Policy choices

| What you want | Settings |
| :- | :- |
| No installed mods, hooks untouched | The guard's `allowManagedModsOnly` |
| No installed mods and no hooks at all, managed hooks included | `disableAllHooks: true` |
| Only your organization's mods | `allowManagedModsOnly` plus correctly deployed organization mods |
| Any mod from marketplaces you approve | Marketplace restrictions plus `disableSideloadFlags` (rejects `--plugin-dir`, `--plugin-url`, `--agents`, `--mcp-config`) |
| Any mod, checked by your own mod | Your policy mod in `prependPlugins` together with `sec-default@builtin` |

Guard options go in managed settings under `pluginConfigs["cc-plugin-sec-default@builtin"].options`: `allowManagedModsOnly` and `allowModsToOverrideDenyRules`. They have no effect anywhere else. If the guard can't read managed settings, it refuses every user's mod (fail closed).

### When a mod counts as your organization's

All three must hold:

- Managed `enabledPlugins` sets the plugin to `true`.
- Managed settings name the plugin's marketplace as a directory on the user's machine, by absolute path.
- The marketplace lists the plugin by a relative path, so it loads in place from that directory.

A plugin copied into the cache from a GitHub, git, URL or npm source counts as a user's. Setting `prependPlugins` replaces the default order, so name `sec-default@builtin` in it to keep the guard.

### Policy mods

A `plugin.register` hook that reads `e.tier` and `e.uses.calls` and returns `{ refuse }` keeps a mod from loading. A hook on an API call event such as `fs.write` audits or refuses other mods' calls. A `plugin.register` hook that throws fails open, so return a refusal from `.catch` to fail closed. Organization mods stop too under `--safe-mode` and after three worker crashes.

### Reviewing a mod before installing it

Check the `hooks:` and `calls:` lines of `claude plugin validate ./some-mod`. Look for:

- **Calls**: `$.fs.*`, `$.process.*`, `$.http.fetch`, `$.env.*`, `$.settings.read`, `$.mcp.call`, `$.model.complete`, `$.prompt.submit`, `$.session.send`
- **Events**: `tool.call`, `prompt.submit`, `session.append`, `ui.render{component=AskUserQuestion}`, `tool.check`

---

## 11. Limits, settings and commands (reference)

### Limits

| Limit | Value |
| :- | :- |
| A hook's own execution time for one event (not counting time in `next` or an API call, except `$.clock.sleep`) | 10 seconds (50 ms for `prompt.edit`) |
| A `.catch` handler | 1 second |
| All `session.end` hooks together | The SessionEnd hook budget (1.5 seconds by default) |
| `$.process.run` | 30 seconds by default, 10 minutes at most |
| `$.model.complete` `maxTokens` | 1024 by default, up to 64,000 or the model's output limit |
| `$.fs.read` / `write` | 4 MiB per file |
| Text in one tree | The first 100,000 characters are drawn |
| `$.store` | 4 MiB in total |
| `$.session.messages()` | The newest 4,096 entries |
| Redraws | 10 a second (30 for the visible pane, the expanded band and the hint line) |
| A pane the mod opens on its own | 144 columns (110 after the user has opened it once) |
| Command, tool, subagent type and pane names | Letters, digits, `_` and `-`, up to 64 characters |

### Settings and environment variables

| Name | Where | What it does |
| :- | :- | :- |
| `CLAUDE_CODE_PLUGIN_DIRS` | Environment, or `env` in `settings.json` | Plugin directories for apps you can't pass `--plugin-dir` to. `:`-separated (`;` on Windows) |
| `CLAUDE_CODE_PLUGIN_DIR_WATCH` | Environment | `1` reloads `--plugin-dir` mods on save in a long-running non-interactive session |
| `prependPlugins` / `appendPlugins` | Managed settings (user settings only in limited cases) | Run order |
| `allowManagedModsOnly` / `allowModsToOverrideDenyRules` | Guard options in managed settings | See section 10 |
| `allowManagedHooksOnly` | Managed settings | Blocks hooks and installed mods that aren't the organization's |
| `disableAllHooks` | Any settings file | In managed settings, stops everything; in user settings, what the organization manages keeps running |
| `disableSideloadFlags` | Managed settings | Rejects the sideload flags |
| `pluginConfigs` | User or managed settings | `userConfig` values. A `--plugin-dir` mod is keyed `<name>@inline` |

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is ignored from v2.1.287, so setting it to `0` doesn't turn mods off.

### Commands

`/plugin` (shows a `N mod active · name` line), `claude plugin validate [--strict] [--json]`, `claude plugin test`, `claude --plugin-dir` (repeatable), `/reload-plugins`, `--safe-mode`, `--debug` / `--debug-file`.

---

## 12. Built-in mods and samples (overview)

| Name in `/plugin` | What it does | How to turn it off |
| :- | :- | :- |
| `cc-plugin-agents-md` | Loads `AGENTS.md` as project instructions | Disable in `/plugin` |
| `cc-plugin-diff` | Takes over `/diff` and draws its pane | Disable in `/plugin` (the built-in `/diff` answers instead) |
| `cc-plugin-plugin-authoring` | The skill for writing mods (no mod code) | Disable in `/plugin` |
| `cc-plugin-sec-default` | The guard that protects what the organization manages | Can't be turned off |
| `cc-plugin-telemetry` | Sends analytics records | Disable in `/plugin`, or `DISABLE_TELEMETRY` |
| `cc-plugin-you-should-know` | A side agent that watches longer tasks and shows notes above the prompt. Off by default | Enable with `/plugin enable cc-plugin-you-should-know@builtin` |

`disableAllHooks`, `--bare` and `--safe-mode` don't stop built-in mods. Source for `diff`, `agents-md`, `sec-default` and `telemetry` is at https://github.com/anthropics/claude-code/tree/main/mods. The samples at https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods are `token-weather` (a forecast of context use in the band), `blast-radius` (holds a risky shell command, shows what it would change, and offers buttons to proceed or cancel) and `replay-theater` (`/replay` steps through the last turn's edits).

---

## 13. Differences between the documentation and the 2.1.292 type declarations

| Item | Documentation | Type declarations / observed |
| :- | :- | :- |
| `prompt.autocomplete` | Not mentioned | Exists (d.ts:4123). Adds typeahead suggestions |
| An event for `$.ui.ask` | "Every mods API method is also an event" (reference) | No `ui.ask` event key; implemented as a `tool.call` of `AskUserQuestion` (d.ts:2420) |
| When `classic.*` fires | Not stated | Even when no settings hook is configured (d.ts:1224) |
| `$.session.surface` | Not mentioned | Deprecated; use `surfaces()` (d.ts:2796) |
| `$.fs.list` result | `{ name, kind, size, isLink }` | Also `mtimeMs` (d.ts:3235) |
| Version mods are on by default | overview: terminal v2.1.287, Desktop v2.1.286; admin: "v2.1.286 and later" | A small disagreement between the two pages. Use 2.1.287 as the floor in the terminal |

---

## 14. APIs that change Claude Code's behavior, with sample code

This section takes the events and API calls from sections 3 to 5 that can **change** something (what Claude Code does, what Claude, the model, reads, or what the screen shows) and arranges them by what you want to change. Events a hook can only observe (`turn.start`, `session.measure` and others) are left out.

Every sample passes `tsc --strict` against the 2.1.292 type declarations and the static analysis of `claude plugin validate --strict`. None of them was run in a live session ([Not verified](#not-verified)).

### 14.1 Index

| Area | What to change | Event / API | What the hook returns | Sample |
| :- | :- | :- | :- | :- |
| Tools | Stop a dangerous tool call | `tool.call` | `{ deny }` | 14.3 (1) |
| Tools | Rewrite a tool's arguments | `tool.call` | `next({ ...e, argument })` | 14.3 (2) |
| Tools | Add a note for Claude after a tool result | `tool.call` | `{ ...result, context }` | 14.3 (3) |
| Tools | Retry a failed tool | `tool.call` | a second `next(e)` | 14.3 (4) |
| Tools | Ask the user before a tool runs | `tool.call` + `$.ui.ask` | `next(e)` or `{ deny }` | 14.3 (5) |
| Tools | Change the permission decision (allow / ask / deny) | `tool.check` | `{ decision, reason }` | 14.3 (6) |
| Tools | Change a tool's description or deferred loading | `tool.describe` | `{ description, isDeferred }` | 14.3 (7) |
| Tools | Add a tool Claude can call | `$.tool.register` + `tool.call` | `{ result }` | 14.3 (8) |
| What Claude reads | Rewrite a prompt, add a note to it, or stop it | `prompt.submit` | `next({ ...e, text, context })`, `{ drop }` | 14.4 (1) |
| What Claude reads | Add a section to the system prompt | `prompt.compose` | `{ sections }` | 14.4 (2) |
| What Claude reads | Rewrite or remove an existing system prompt section | `prompt.section` | `{ text }`, `{ text: null }` | 14.4 (3) |
| What Claude reads | Add to the context at the start of a conversation (CLAUDE.md and the like) | `prompt.context` | `{ blocks }` | 14.4 (4) |
| What Claude reads | Rewrite or remove a reminder Claude Code adds | `prompt.attachment` | `{ text }`, `{ text: null }` | 14.4 (5) |
| What Claude reads | Swap or refuse the file an @-mention reads | `prompt.mention` | `next({ ...e, path })`, `{ deny }` | 14.4 (6) |
| What Claude reads | Append to a skill's body | `skill.prompt` | `{ text }` | 14.4 (7) |
| What Claude reads | Change the attribution text of commits and PRs | `attribution.text` | `{ text }` | 14.4 (8) |
| Prompt box | Never show the dim prompt suggestion | `prompt.suggest` | `{ isShown: false }` | 14.5 (1) |
| Prompt box | Add typeahead suggestions (undocumented) | `prompt.autocomplete` | `{ suggestions }` | 14.5 (2) |
| Model | Change the model or effort per request | `turn.step` | `yield* next({ ...e, model, effort })` | 14.6 (1) |
| Model | Show one line under the answer when a turn ends | `turn.complete` | `{ ...result, text }` | 14.6 (2) |
| Model | Interrupt a turn that runs too long | `turn.start` + `$.turn.abort` | — | 14.6 (3) |
| Model | Confirm or refuse the user's `/model` switch | `classic.PreModelSwitch` | `{ permissionDecision }` | 14.6 (4) |
| Subagents | Pick a subagent's model, or refuse to start it | `agent.spawn` | `next({ ...e, model })`, `{ deny }` | 14.7 (1) |
| Subagents | Hide a subagent type from Claude | `agent.offer` | `{ isOffered: false }` | 14.7 (2) |
| Subagents | Add a subagent type | `$.agent.register` | — | 14.7 (3) |
| Commands | Add a slash command | `$.command.register` + `command.run` | `{ text }` | 14.8 (1) |
| Commands | Fill in a built-in command's arguments | `command.run` | `next({ ...e, args })` | 14.8 (2) |
| Commands | Hide a command from the list | `command.describe` | `{ ...result, isHidden: true }` | 14.8 (3) |
| Settings | Refuse a `/config` change, or hide a row | `config.set` / `config.describe` | `{ deny }`, `{ isHidden: true }` | 14.8 (4) |
| Session | Add compaction instructions, or stop a compaction | `session.compact` | `next({ ...e, instructions })`, `{ skip }` | 14.9 (1) |
| Session | Keep a message from another session away from Claude | `session.receive` | `{ consumed }` | 14.9 (2) |
| Session | Stop a message to another session | `session.send` | `{ isDelivered: false, reason }` | 14.9 (3) |
| Session | Rewrite what the conversation log stores | `session.append` | `next({ ...e, message })` | 14.9 (4) |
| Interface | Change how one of Claude Code's own rows (the spinner and others) looks | `ui.render` | `next({ ...e, props })` | 14.10 (1) |
| Interface | Add your own elements to the question dialog | `ui.render` (`AskUserQuestion`) | an element tree | 14.10 (2) |
| Other mods | Refuse to load a mod | `plugin.register` | `{ refuse }` | 14.11 (1) |
| Other mods | Refuse another mod's API call | API call events such as `fs.write` | `{ deny }` | 14.11 (2) |
| Other mods | Add a namespace to, or remove one from, the `$` a mod receives | `engine.create` | the API with the namespace added | section 3 |
| Settings hooks | Return from a mod the decisions a settings hook returns | `classic.*` | fields of `ClassicResult` | 14.12 |
| Actions | Start a turn, compact, change a setting or an environment variable, and more | `$.prompt.submit`, `$.session.compact`, `$.env.set` and others | — | 14.13 |

### 14.2 Skeleton

The samples below show only the **body** of the `register` function in `hooks/register.ts`. Each one works when pasted at `// sample goes here` in this skeleton:

```typescript
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  // sample goes here
}
```

Assumptions:

- The plugin is named `example` (`name` in `.claude-plugin/plugin.json`). A tool registered with `$.tool.register` is called `mcp__example__<name>`.
- `$.tool.register`, `$.command.register` and `$.agent.register` reject until the session binds, so they are called in a `session.start` hook.
- Registering one event twice without a matcher makes the module fail to load. To put several samples in one mod, merge the hooks of the same event into one.
- `$` is always written as `$.namespace.method(...)` (the static-analysis rules in section 7).

### 14.3 Tool calls

(1) Stop a dangerous command. Claude reads the `{ deny }` string as the tool's error result. No permission prompt appears.

```ts
on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
  if (/\brm\s+-\w*(rf|fr)/.test(e.command)) {
    return { deny: 'rm -rf is blocked in this repository. Remove the files by name.' }
  }
  return next(e)
})
```

(2) Rewrite the arguments. In auto mode, a call rewritten after the classifier reviewed it can be refused (section 9).

```ts
on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
  if (!/^git (log|diff|show)\b/.test(e.command)) return next(e)
  return next({ ...e, command: e.command.replace(/^git /, 'git --no-pager ') })
})
```

(3) Add a note after the tool result that only Claude reads. The user does not see it.

```ts
on('tool.call', { tool: 'Read' }, async ($, e, next) => {
  const result = await next(e)
  if (result.deny !== undefined || !e.file_path.includes('/generated/')) return result
  return {
    ...result,
    context: [
      ...(result.context ?? []),
      'This file is generated. Edit the schema under schema/ and run `pnpm gen` instead.',
    ],
  }
})
```

(4) Retry once on failure. The time spent in `$.clock.sleep` counts toward the hook's time limit (10 seconds).

```ts
on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
  const first = await next(e)
  if (first.isError !== true) return first
  await $.clock.sleep(2000)
  return next(e)
})
```

(5) Let the user choose before the call runs. `$.ui.ask` rejects when the dialog is dismissed and under `-p`, so `.catch` returns `{ deny }` to fail closed.

```ts
on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
  if (!/\bgit\s+push\b/.test(e.command)) return next(e)
  const answer = await $.ui.ask(`Run "${e.command}"?`, ['Push', 'Cancel'])
  return answer === 'Push' ? next(e) : { deny: 'The user cancelled the push.' }
}).catch(() => ({ deny: 'The push was not confirmed.' }))
```

(6) Change the permission decision. `next(e)` returns the decision that the rules, the permission mode and the settings hooks reached. This sample turns `ask` into `allow` only for read-only git commands with no shell separators. Where the built-in guard loads, a mod cannot approve a call that a `deny` rule refused (section 10).

```ts
on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
  const verdict = await next(e)
  const { command } = e.input as { command: string }
  if (verdict.decision === 'ask' && /^git (status|diff|log)( [^;&|`$<>()]*)?$/.test(command)) {
    return { decision: 'allow', reason: 'read-only git command' }
  }
  return verdict
})
```

(7) Change a tool's description, or whether it is deferred behind ToolSearch. A description that changes on every request defeats the prompt cache, so use a fixed string.

```ts
on('tool.describe', { tool: 'Bash' }, async ($, e, next) => {
  const described = await next(e)
  return {
    ...described,
    description: `${described.description}\n\nIn this repository run tests with \`pnpm test\`, never \`npm test\`.`,
  }
})

on('tool.describe', { tool: /^mcp__github__/ }, async ($, e, next) => ({
  ...(await next(e)),
  isDeferred: false,
}))
```

(8) Add a tool. Claude sees it as `mcp__example__word_count`, and a `tool.call` hook does the work by returning `{ result }`. A call that no hook answers fails.

```ts
on('session.start', async ($, e, next) => {
  await $.tool.register({
    name: 'word_count',
    description: 'Counts the words of a text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  })
  return next(e)
})

on('tool.call', { tool: 'mcp__example__word_count' }, async ($, e) => {
  const { text } = e as unknown as { text: string }
  return { result: { words: text.split(/\s+/).filter(Boolean).length } }
})
```

A hook can also answer a built-in tool's call with `{ result }`, but Claude Code validates the answer against the tool's output schema when it has one, so the result must take the tool's own shape (`claude-code-tools/index.d.ts`).

### 14.4 What Claude reads

(1) Rewrite a prompt, add a note to it, or stop it. A changed `text` also shows in the transcript. The user never sees `context`. The `{ drop }` string is shown to the user as the reason.

```ts
on('prompt.submit', async ($, e, next) => {
  if (/\bAKIA[0-9A-Z]{16}\b/.test(e.text)) {
    return { drop: 'The prompt contains an AWS access key ID. Remove it and send again.' }
  }
  const text = e.text.replace(/^ja:\s*/, '')
  if (text === e.text) return next(e)
  return next({ ...e, text, context: [...(e.context ?? []), 'Answer this prompt in Japanese.'] })
})
```

(2) Add a section to the system prompt. Write the `id` as `<plugin>:<name>`. Use `scope: 'shared'` only for text that reads the same for every user, and `session` for text that varies by repository (every `shared` section must come before the `session` ones).

```ts
on('prompt.compose', async ($, e, next) => {
  const { sections } = await next(e)
  return {
    sections: [
      ...sections,
      { id: 'example:review', text: 'Keep each change small enough to review in one sitting.', scope: 'session' },
    ],
  }
})
```

(3) Rewrite a named section of the system prompt. The section names (`env_info_simple`, `memory` and others) are the `id`s in `prompt.compose`'s `sections`. Returning `{ text: null }` removes the section.

```ts
on('prompt.section', { name: 'env_info_simple' }, async ($, e, next) => {
  const { text } = await next(e)
  return { text: text === null ? null : `${text}\nOutbound HTTP goes through the corporate proxy.` }
})
```

(4) Add a block to the context that comes with the first message of a conversation (the contents of CLAUDE.md and the like). It fires once per conversation.

```ts
on('prompt.context', async ($, e, next) => {
  const result = await next(e)
  const conventions = await $.fs.read('docs/CONVENTIONS.md').catch(() => undefined)
  if (conventions === undefined) return result
  return { ...result, blocks: [...result.blocks, { name: 'conventions', text: conventions }] }
})
```

(5) Rewrite a message Claude Code adds to the conversation (a reminder and the like). `e.type` names its kind. The type declarations define the content (`e.detail`) of three kinds, `plan_mode`, `plan_mode_reentry` and `plan_mode_exit`; every other kind carries only its `text`.

```ts
on('prompt.attachment', { type: 'plan_mode' }, async ($, e, next) => {
  const { text } = await next(e)
  return { text: text === null ? null : `${text}\n\nWrite the plan in Japanese.` }
})
```

(6) Swap the file an @-mention reads, or refuse to attach it (v2.1.290 and later).

```ts
on('prompt.mention', async ($, e, next) => {
  if (/\.(pem|key)$/.test(e.path)) return { deny: 'private keys are never attached' }
  if (/(^|\/)\.env$/.test(e.path)) return next({ ...e, path: `${e.path}.example` })
  return next(e)
})
```

(7) Append to a skill's body. The matcher's `skill` is the skill's name.

```ts
on('skill.prompt', { skill: 'commit' }, async ($, e, next) => {
  const { text } = await next(e)
  return { text: `${text}\n\nSign every commit with \`git commit --gpg-sign\`.` }
})
```

(8) Change the attribution text added to commits and PRs. `kind` is one of `commit`, `pr`, `exemption` and `remedy`.

```ts
on('attribution.text', { kind: 'commit' }, async ($, e, next) => {
  const { text } = await next(e)
  return { text: `${text}\nReviewed-by: nobody yet` }
})
```

### 14.5 Prompt box

(1) Never show the dim suggestion in the prompt box. Returning `{ isShown: false }` without calling `next` keeps every suggestion from showing, Claude Code's own included.

```ts
on('prompt.suggest', async () => ({ isShown: false }))
```

(2) Add typeahead suggestions. This 2.1.292 event is not in the documentation (d.ts:4123, 8173). A taken suggestion replaces the token at the cursor (`e.token`). The rows appear below Claude Code's own.

```ts
on('prompt.autocomplete', async ($, e, next) => {
  const result = await next(e)
  if (!e.token.startsWith(':')) return result
  const snippets = [
    { text: 'Looks good to me.', label: ':lgtm', description: 'approval' },
    { text: 'Please add a test that fails without this change.', label: ':test', description: 'ask for a test' },
  ].filter((s) => s.label.startsWith(e.token))
  return { suggestions: [...result.suggestions, ...snippets] }
})
```

### 14.6 Model and turns

(1) Change the model or the effort of each model request. A `turn.step` hook is an async generator that streams the response with `yield* next(e)` (a plain async function is a type error). A subagent's request carries `e.agentId`.

```ts
on('turn.step', async function* ($, e, next) {
  if (e.agentId !== undefined) {
    return yield* next({ ...e, model: 'claude-haiku-4-5-20251001' })
  }
  return yield* next({ ...e, effort: e.index === 0 ? 'high' : 'medium' })
})
```

(2) Show one line under the answer at the end of a turn.

```ts
on('turn.complete', async ($, e, next) => {
  const result = await next(e)
  if (e.usage === undefined) return result
  const seconds = Math.round(e.durationMs / 1000)
  return { ...result, text: `${e.usage.output_tokens} output tokens in ${seconds}s` }
})
```

(3) Interrupt a turn that runs longer than ten minutes. The timer comes from `$.clock` (there is no `setTimeout`) and is cancelled when the turn ends.

```ts
const timers = new Map<string, { cancel: () => void }>()

on('turn.start', async ($, e, next) => {
  const result = await next(e)
  const timer = $.clock.after(10 * 60_000, () => {
    $.turn.abort({ turnId: e.turnId })
  })
  timers.set(e.turnId, timer)
  return result
})

on('turn.complete', async ($, e, next) => {
  timers.get(e.turnId)?.cancel()
  timers.delete(e.turnId)
  return next(e)
})
```

(4) Step into a switch of the session's model (`/model`, the Model row of `/config`, the model picker, or the SDK's `set_model`). `e` carries the models before and after, whether the prompt cache is warm, and the estimated cost of re-caching (`estimated_cache_write_usd`). This sample returns `'ask'` when discarding a warm cache would cost a dollar or more (the type accepts `ask`; whether a confirmation dialog appears was not checked). Returning `'deny'` stops the switch. No API changes the session's model directly (`$.session.model()` only reads it); the route the type declarations show is `$.command.run({ command: 'model', args: 'opus' })`, which does what the user typing `/model opus` does (not run to confirm). A switch by automatic fallback (`source: 'auto'`) raises no `PreModelSwitch`, so a mod cannot stop it and learns of it only afterwards through `classic.PostModelSwitch`.

```ts
on('classic.PreModelSwitch', async ($, e, next) => {
  if (!e.prompt_cache_warm || e.estimated_cache_write_usd < 1) return next(e)
  return {
    permissionDecision: 'ask',
    permissionDecisionReason: `Switching to ${e.to_model} re-caches about $${e.estimated_cache_write_usd.toFixed(2)} of context.`,
  }
})
```

### 14.7 Subagents

(1) Pick a subagent's model, or refuse to start it. Starting an agent team teammate raises the same event, with `e.isTeammate` set.

```ts
on('agent.spawn', async ($, e, next) => {
  if (e.isTeammate === true) return { deny: 'Agent teams are turned off in this repository.' }
  if (e.subagentType === 'Explore') return next({ ...e, model: 'haiku' })
  return next(e)
})
```

(2) Keep a subagent type from being offered to Claude. `$.agent.spawn` can still start it.

```ts
on('agent.offer', { agent: 'general-purpose' }, async () => ({ isOffered: false }))
```

(3) Add a subagent type. It is named `<plugin>:<name>` (here `example:reviewer`) and takes the same fields as an agent file.

```ts
on('session.start', async ($, e, next) => {
  await $.agent.register({
    name: 'reviewer',
    description: 'Reviews the staged diff for correctness bugs. Use before committing.',
    prompt: 'You review `git diff --cached`. Report only defects that change behavior, with file and line.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: 'opus',
  })
  return next(e)
})
```

### 14.8 Commands and settings

(1) Add a slash command. With `immediate: true` it runs at once while Claude is working, without waiting for the turn. `{ text }` shows in the transcript, and Claude reads it too.

```ts
on('session.start', async ($, e, next) => {
  await $.command.register({ name: 'branch', description: 'Shows the current git branch.', immediate: true })
  return next(e)
})

on('command.run', { command: 'branch' }, async ($) => {
  const run = await $.process.run(['git', 'branch', '--show-current'])
  return { text: run.exitCode === 0 ? run.stdout.trim() : run.stderr.trim() }
})
```

(2) Fill in a built-in command's arguments. This sample gives `/compact` with no arguments an instruction for the summary. When a single command is the whole prompt of a `-p` run, the hook can set the process's exit code with `{ text, exitCode }`.

```ts
on('command.run', { command: 'compact' }, async ($, e, next) => {
  if (e.args.trim() !== '') return next(e)
  return next({ ...e, args: 'Keep every file path, command and decision verbatim.' })
})
```

(3) Hide a command from the list (the typeahead). A hidden command still runs when typed in full, so to stop it from running, answer its `command.run` with `{ text }`.

```ts
on('command.describe', { command: ['upgrade', 'passes'] }, async ($, e, next) => ({
  ...(await next(e)),
  isHidden: true,
}))
```

(4) Refuse a `/config` change, or hide a row. The key names are the `key`s that `$.config.list()` returns.

```ts
on('config.set', { key: 'verbose' }, async ($, e, next) => {
  if (e.value === false) return { deny: 'verbose output stays on in this repository' }
  return next(e)
})

on('config.describe', { key: 'theme' }, async ($, e, next) => ({ ...(await next(e)), isHidden: true }))
```

### 14.9 Session

(1) Add instructions to a compaction. Returning `{ skip: reason }` stops the compaction, and returning `{ messages }` uses those messages in place of the summary (this repository's `mods/decision-compaction` does the latter).

```ts
on('session.compact', async ($, e, next) => {
  const rule = 'Keep every open task and every decision with its reason.'
  const instructions = e.instructions === undefined ? rule : `${e.instructions}\n${rule}`
  return next({ ...e, instructions })
})
```

(2) Handle a message from another agent or session without passing it to Claude.

```ts
on('session.receive', async ($, e, next) => {
  if (!/^\s*ping\s*$/i.test(e.text)) return next(e)
  $.ui.toast('ping received')
  return { consumed: 'ping is answered by the example mod' }
})
```

(3) Stop a message to another session (sends from the SendMessage tool included).

```ts
on('session.send', async ($, e, next) => {
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(e.text)) {
    return { isDelivered: false, reason: 'the message contains a private key' }
  }
  return next(e)
})
```

(4) Rewrite what the conversation log stores. It fires before each row (a prompt, a response, a tool result and so on) is stored. This sample masks AWS access key IDs in text blocks.

```ts
on('session.append', async ($, e, next) => {
  const content = e.message.content.map((block) =>
    block.type === 'text' && typeof block.text === 'string'
      ? { ...block, text: block.text.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA****') }
      : block,
  )
  return next({ ...e, message: { ...e.message, content } })
})
```

### 14.10 Replacing parts of the interface

(1) Change some props of one of Claude Code's own rows. The sites and their props are in the table in section 5.

```ts
on('ui.render', { component: 'Spinner' }, async ($, e, next) =>
  next({ ...e, props: { ...e.props, word: 'Brewing' } }),
)
```

(2) Add your own elements above the question dialog (`AskUserQuestion`). The tree must hold Claude Code's own dialog, which `await next(e)` returns, exactly once; otherwise only Claude Code's own dialog is drawn. The sample uses JSX, so the file is named `.tsx`. The permission prompt cannot be changed.

```tsx
on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      <Text color="yellow">Claude is waiting for your answer.</Text>
      {await next(e)}
    </Box>
  )
})
```

To show something without starting a turn, use `$.ui.status` (one line under the prompt), `$.ui.toast` (a toast at the top right) or `$.ui.log` (a dim transcript line) (section 4).

### 14.11 Other mods and policy

A policy mod goes in `prependPlugins` so that it runs before the user's mods, on the outside of the chain (section 10).

(1) Refuse to load mods that match a condition. A hook that throws fails open, so `.catch` returns `{ refuse }` to fail closed.

```ts
on('plugin.register', async ($, e, next) => {
  if (e.tier === 'user' && e.uses.calls.some((call) => call.startsWith('process.'))) {
    return { refuse: 'user mods may not start processes on this machine' }
  }
  return next(e)
}).catch(() => ({ refuse: 'the plugin policy could not be checked' }))
```

(2) Refuse another mod's API call. Every mods API method is also an event, and `next.origin` names the calling mod and its tier.

```ts
on('fs.write', async ($, e, next) => {
  if (next.origin.tier === 'user' && /(^|\/)\.git\/hooks\//.test(e.path)) {
    return { deny: 'mods may not write git hooks' }
  }
  return next(e)
})
```

### 14.12 Settings hook events (`classic.*`)

A mod can return the decisions a settings hook (`hooks` in `settings.json`) returns. `e` is the JSON a settings hook receives on stdin, and the result takes the fields of `ClassicResult` (d.ts:1266). They map to a settings hook's JSON output as follows:

| `ClassicResult` field | In a settings hook | Events it applies to |
| :- | :- | :- |
| `block` | `decision: "block"` with `reason` (exit code 2 from a command hook) | the event's block, veto or re-prompt |
| `preventContinuation` / `stopReason` | `continue: false` / `stopReason` | stop the session after the event |
| `additionalContext` | `hookSpecificOutput.additionalContext` | text handed to Claude |
| `sessionTitle` | `hookSpecificOutput.sessionTitle` | UserPromptSubmit, SessionStart |
| `suppressOriginalPrompt` | `hookSpecificOutput.suppressOriginalPrompt` | UserPromptSubmit, UserPromptExpansion |
| `initialUserMessage` / `watchPaths` / `reloadSkills` | the fields of the same name in `hookSpecificOutput` | SessionStart |
| `permissionDecision` / `permissionDecisionReason` | the fields of the same name in `hookSpecificOutput` | PreModelSwitch |
| `decision` | `hookSpecificOutput.decision` (`behavior: 'allow' / 'deny'`) | PermissionRequest |
| `updatedToolOutput` / `updatedMCPToolOutput` | the fields of the same name in `hookSpecificOutput` | PostToolUse |
| `retry` | `hookSpecificOutput.retry` | PermissionDenied |
| `displayContent` | `hookSpecificOutput.displayContent` | MessageDisplay |
| `worktreePath` | `hookSpecificOutput.worktreePath` | WorktreeCreate |

Only `classic.PreToolUse` takes a different `e`, the tool call's envelope, so `tool.call` is the plainer way to change a tool call.

This sample keeps Claude working until the tests pass. A `block` on `Stop` reaches Claude as an instruction to keep going instead of stopping. When `stop_hook_active` is set, blocking again would loop forever, so the hook lets the stop through.

```ts
on('classic.Stop', async ($, e, next) => {
  if (e.stop_hook_active) return next(e)
  const run = await $.process.run(['pnpm', 'test'], { timeoutMs: 5 * 60_000 })
  if (run.exitCode === 0) return next(e)
  return { block: `pnpm test failed. Fix it before stopping:\n${run.stdout.slice(-2000)}` }
})
```

### 14.13 Making Claude Code act through API calls

These APIs make Claude Code do something when a mod calls a `$` method, rather than through what a hook returns.

| API | What it does |
| :- | :- |
| `$.prompt.submit({ text, asUser? })` | Starts a new turn once the session is idle. By default a sentence naming the mod comes first |
| `$.prompt.fill({ text, mode })` / `$.prompt.suggest({ text })` | Replaces, appends to or inserts into the draft in the prompt box / shows a dim suggestion |
| `$.session.compact({ instructions? })` | Runs a compaction |
| `$.session.append({ message })` | Adds a row (`user` or `system`) to the conversation |
| `$.session.send({ to, text })` | Sends a message to another agent or session (delivered as the SendMessage tool delivers) |
| `$.turn.abort({ turnId })` | Stops a running turn and its running tools |
| `$.command.run({ command, args? })` | Runs a slash command as if the user typed it |
| `$.config.set({ key, value })` | Changes a `/config` row |
| `$.env.set(name, value)` | Changes an environment variable, also for the commands and MCP servers Claude Code starts afterwards |
| `$.agent.spawn({ prompt, subagentType? })` | Starts a subagent in the background |
| `$.tool.call({ tool, ...arguments })` | Calls a tool (through the other mods' `tool.call` hooks) |

This sample compacts and then asks for a handoff note on `/handoff`, and turns off the pager for the commands that follow.

```ts
on('session.start', async ($, e, next) => {
  await $.command.register({ name: 'handoff', description: 'Compacts, then asks Claude for a handoff note.' })
  await $.env.set('GIT_PAGER', 'cat')
  return next(e)
})

on('command.run', { command: 'handoff' }, async ($) => {
  await $.session.compact({ instructions: 'Keep open tasks and decisions.' })
  await $.prompt.submit({ text: 'Write a handoff note for the next session in HANDOFF.md.', asUser: true })
  return {}
})
```

## Not verified

- Drawing in the Desktop app (`Svg`, the Desktop hotkey display) was not tried on a real machine.
- `prompt.autocomplete` was read from the type declarations only, not tried in a live session.
- The behavior of name-only methods (`$.agent.*`, `$.audio.*`, `$.session.authorize`, `$.model.classify` and others) comes from comments in the type declarations and was not exercised.
- Whether `cc-plugin-you-should-know` is available to a given organization has to be checked in `/plugin` → Installed → Show disabled.
- The 40 samples in section 14 passed `tsc --strict` (TypeScript 5.9.3) against the Claude Code 2.1.292 type declarations and `claude plugin validate --strict` on 2026-10-07. Each was checked as a mod of its own; none was run in a live session. In particular, the runtime behavior of the 14.13 sample, which calls `$.session.compact` and then `$.prompt.submit` from a `command.run` hook, and of the 14.6 (1) sample, which changes `effort` in `turn.step`, is unconfirmed.
