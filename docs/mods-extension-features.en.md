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
| This repository's `mods/types/` | — | Written by 2.1.289, older than the installed 2.1.292 (it lacks `prompt.mention` and `prompt.autocomplete`) |

## Not verified

- Drawing in the Desktop app (`Svg`, the Desktop hotkey display) was not tried on a real machine.
- `prompt.autocomplete` was read from the type declarations only, not tried in a live session.
- The behavior of name-only methods (`$.agent.*`, `$.audio.*`, `$.session.authorize`, `$.model.classify` and others) comes from comments in the type declarations and was not exercised.
- Whether `cc-plugin-you-should-know` is available to a given organization has to be checked in `/plugin` → Installed → Show disabled.
