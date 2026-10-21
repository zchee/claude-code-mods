# gateway-switch

A Claude Code mod that switches a running session between
`api.anthropic.com` and a local
[Model Gateway](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/model-gateway):
onto the gateway once Remote Control has registered, on `/gateway on`, or
as the session starts after `/gateway setup`, and back to
`api.anthropic.com` while the gateway does not answer.

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
3. Load this mod, for example `claude --plugin-dir mods/gateway-switch`.
4. Optionally, run `/gateway setup` once in the project so that every
   session started there turns the gateway on at once (see
   [On at every start](#on-at-every-start)).

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
- **Teammates.** Since 2.1.301 Claude Code starts a tmux teammate with every
  variable a person's plugin wrote set back to the value it had before the
  write, so `/gateway on` in a lead never reaches the teammates it spawns:
  they start on `api.anthropic.com`, and one whose agent pins a gateway
  model falls back to the lead's. The mod therefore has each lead write its
  mode and the env block it wired to
  `~/.claude/gateway-switch/leads/<session id>.json` on every change and
  again just before it spawns a teammate (under each id it has had, since
  `/clear` gives the process a new one), and a session whose
  command line carries `--agent-id` and `--parent-session-id` (how Claude
  Code starts a tmux teammate) reads its lead's file. It wires at session
  start from that block, without starting the gateway CLI (a few hundred
  milliseconds), and holds each model request at `turn.step` until that is
  done, so its first request already goes through the gateway. A hook may
  hold a request for at most 10 seconds of its own time; a lead file
  without an env block makes the teammate run the gateway CLI instead,
  which can take longer, and its first request then goes out unwired. Every check after that wires it when
  the lead is on and unwires it when the lead was turned off. While the
  lead still waits for Remote Control, a teammate wired some other way (a
  gateway URL in the tmux environment) is left as it is, and so is every
  teammate of a lead that wrote no file (an older version of this mod).
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
| `setup` | Adds a SessionStart hook to the project's `.claude/settings.local.json` that turns the gateway on as each session starts there; the current session is left as it is |
| none, or `status` | Says whether the session is waiting, following its lead, on, suspended or off |

In a teammate, `on` and `off` also stop it from following its lead.

## On at every start

`/gateway setup` adds this group to `hooks.SessionStart` in the project's
`.claude/settings.local.json`, keeping everything else the file holds, and
does nothing when the group is already there:

```json
{
  "matcher": "startup|resume|fork",
  "hooks": [
    {
      "type": "command",
      "command": ": gateway-switch turns the gateway on as each session here starts"
    }
  ]
}
```

The group marks the project; the hook itself does nothing (`:` is the
shell's no-op) and sends Claude Code nothing. As each session starts, the
mod reads the project's `.claude/settings.local.json`, and when the group
is there it turns the gateway on itself, the same way in every kind of
session, `claude -p` and the Agent SDK included. It wires without holding
`session.start`, and each model request waits for the wiring as a
teammate's does.

The mod reads the file instead of watching the hook run. Claude Code can
seat its security default plugin (`cc-plugin-sec-default`) before the
plugins a person installs: on a Team or Enterprise plan, on a machine with
managed settings or a managed MCP server file, and by default on any plan
while it cannot yet tell that neither applies, until the process ends. That plugin passes every
`classic.*` hook of theirs over, `classic.SessionStart` included. Since 2.1.304 Claude Code says so in
the transcript (`its classic.SessionStart hook was skipped.
"cc-plugin-sec-default" runs first and sent the event on past it.`), the
line earlier versions of this mod, which watched the hook, caused.

- The mod reads the file once per process: a new session (`startup`), a
  resumed one (`claude --resume`) and a forked one. `/clear`, compaction
  and `/resume` inside a running session keep the process, and with it the
  mode the session already had; a session still waiting for Remote Control
  stays waiting through them.
- Earlier versions of `/gateway setup` wrote a hook that answered
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","initialUserMessage":"/gateway on"}}`.
  The mod still reads that group as the same mark, and a lead whose
  project holds it says so in a toast at start. Run `/gateway setup` again
  to replace it: Claude Code puts that message before the prompt of a
  `claude -p` run, where `/gateway on` also wires a session whose
  `ANTHROPIC_BASE_URL` points at another endpoint, and without this mod it
  answers `Unknown command`. `setup` removes the old hook, and its group
  when nothing else is left in it.
- The mod reads the file even where Claude Code does not run the hook (all
  hooks disabled, or managed settings allowing only managed hooks): the
  group is a mark the mod reads, not a hook it waits for.
- `setup` rewrites the file as two-space JSON. A change Claude Code writes
  to the same file between its read and its write (an "always allow" from
  another session in the project) is lost.
- The session does not wait for Remote Control: it starts wired, and
  `/remote-control` does not work in a wired session (see
  [below](#remote-control-in-a-wired-session)). `/gateway rc` opens it.
- A tmux teammate reads the same file, and keeps following its lead instead
  of turning on by itself. A session whose `ANTHROPIC_BASE_URL` already
  points at another endpoint is left alone, as it is without the group.
- The group takes effect from the next session; `/gateway on` switches the
  current one. To stop it, delete the group from the file.

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
- Only tmux teammates follow their lead. An in-process teammate or a
  subagent runs in the lead's own process and is wired with it.
- The plugin API has no way to delete a file, so each lead's file stays in
  `~/.claude/gateway-switch/leads/` after the session ends; each is a few
  hundred bytes.
- The `turn.step` hook passes every session's model responses through the
  mod's hooks worker, whether or not the session is a teammate, because a
  hook cannot be registered for teammates alone.
- Where an organization manages Claude Code's settings, Claude Code can hold
  a write to a variable the person could not set there (the plugin API
  gained this between 2.1.296 and 2.1.301). The mod then undoes the writes
  it made, says which hold stopped it, and turns itself off; `/gateway on`
  tries again. A session that started already pointed at the gateway
  clears only the base URL on `/gateway off`, and does not notice when
  that one write is held.
- The `/model` picker shows gateway rows from Model Gateway's discovery
  cache (`~/.claude/cache/gateway-models.json`), which Claude Code reads
  only while the base URL matches it; models the gateway added since the
  cache was written appear after a session that started wired.

## Tests

`claude plugin test mods/gateway-switch` runs the tests in `tests/`
without a session or network access: the environment, the gateway CLI, the
health endpoint, the file system and the clock are answered from memory.
