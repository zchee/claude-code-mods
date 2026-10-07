# mods-gateway-rc

A Claude Code mod that keeps a session on `api.anthropic.com` until Remote
Control has registered, then routes it through a local
[Model Gateway](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/model-gateway),
and routes it back to `api.anthropic.com` while the gateway does not
answer.

Remote Control refuses to start in a session whose `ANTHROPIC_BASE_URL`
points anywhere but `api.anthropic.com`, and Model Gateway works by setting
that variable in the project's settings. This mod sets it on the running
process instead, after Remote Control is up, so one session can have both.

It does not replace Model Gateway. The gateway itself (the proxy and shim
that route ChatGPT/Codex, Grok, Kimi, Cursor and OpenCode Go models), its
supervisor, its CLI and its skill all stay with the model-gateway plugin,
which must be installed. This mod only decides when the session uses it.

## Setup

1. Install and set up the model-gateway plugin as its README says.
2. Leave `ANTHROPIC_BASE_URL` out of every settings file the project
   reads. The mod sets the whole env block itself, so the project's
   `.claude/settings.local.json` can be empty. Run model-gateway's setup as
   `setup --preserve-wiring`: plain `setup` writes the project's wiring,
   and a session that starts wired cannot start Remote Control. A wiring it
   wrote by mistake is undone by removing `ANTHROPIC_BASE_URL` from the
   file. model-gateway's SessionStart line saying the project is not wired
   is expected.
3. Load this mod, for example `claude --plugin-dir mods/mods-gateway-rc`.

## What it does

On `session.start` it registers `/gateway` and starts a check every two
seconds. A session whose `ANTHROPIC_BASE_URL` already points elsewhere is
left alone; one already pointed at the gateway counts as wired.

- **Remote Control detection.** After Remote Control registers an
  environment, Claude Code writes `bridge-pointer.json` into the project's
  folder under `~/.claude/projects` (the one that holds the session's
  transcript), naming the pid of the process that owns it. Every session
  also listens on a messaging socket named after its own pid
  (`CLAUDE_CODE_MESSAGING_SOCKET`, `.../cc-socks/<pid>.sock`). When the
  pointer names this process, the mod wires the gateway.
- **Wiring.** It runs `model-gateway.js ensure --quiet`, reads the env block
  `model-gateway.js env` prints (the base URL, the fixed switches and the
  Claude alias pins), checks `/healthz`, remembers the values the session
  had, and sets the block on the process with `ANTHROPIC_BASE_URL` last.
  Claude Code builds its API client for every request and reads the
  variable each time, so the next request goes to the gateway.
- **Health watchdog.** Two checks in a row that get no answer within three
  seconds restore the remembered values, which sends requests back to
  `api.anthropic.com`. Two answering checks wire the gateway again. While
  it is down, `ensure --quiet` runs at most every 30 seconds. A gateway that
  answers with `ok: false` stays wired, since only the proxy behind it is
  down and Claude models still pass through; a toast says so once.

## `/gateway`

| Argument | Effect |
| :- | :- |
| `on` | Wires the gateway now, without waiting for Remote Control |
| `off` | Restores the remembered values and stays off, through Remote Control and gateway recovery alike |
| `rc` | Opens Claude Code's own `/remote-control` dialog from a wired session (connect, or disconnect before switching accounts), then wires the gateway again |
| none, or `status` | Says whether the session is waiting, on, suspended or off |

## `/remote-control` in a wired session

Claude Code enables `/remote-control` only while `ANTHROPIC_BASE_URL`
points at `api.anthropic.com`, and it rebuilds the command list only when
plugins reload. A session wired after the list was built still offers the
command, and running it answers `Unknown command: /remote-control`; after
the next reload the command is gone. Remote Control itself stays connected
while the session is wired.

`/gateway rc` works around both: it unwires the gateway, runs
`/reload-plugins` so that the list is rebuilt while the session is
first-party, runs `/remote-control`, and wires the gateway again when the
dialog closes. The health watchdog holds still meanwhile, and a
`/gateway off` given during the dialog keeps the session unwired. If the
rebuilt list still has no `/remote-control`, Remote Control is disabled for
another reason (sign-in, organization policy, a feature flag) and a toast
says so.

## Limits

- Remote Control detection by `bridge-pointer.json` did not fire in a live
  2.1.292 session: Claude Code connected Remote Control without writing the
  file where the mod looks (it may keep the pointer in its v5 storage). Use
  `/gateway on` once Remote Control is up.
- A request already retrying when the gateway goes down may keep retrying
  against it; requests that start after the switch go to
  `api.anthropic.com`.
- `claude -p` and the Agent SDK never register Remote Control, so they are
  wired only by `/gateway on`.
- The `/model` picker shows gateway rows from Model Gateway's discovery
  cache (`~/.claude/cache/gateway-models.json`), which Claude Code reads
  only while the base URL matches it; models the gateway added since the
  cache was written appear after a session that started wired.

## Tests

`claude plugin test mods/mods-gateway-rc` runs the tests in `tests/`
without a session or network access: the environment, the gateway CLI, the
health endpoint, the file system and the clock are answered from memory.
