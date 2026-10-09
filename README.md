# claude-code-mods

Opinionated [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
mods: plugins that run TypeScript hooks inside the Claude Code process and
change how a session behaves.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Plugin API: Claude Code 2.1.295](https://img.shields.io/badge/plugin%20API-Claude%20Code%202.1.295-8A2BE2.svg)](mods/types/claude-code/index.d.ts)

A mod is a plugin whose `hooks/hooks.json` names JavaScript or TypeScript
modules. Those modules subscribe to events (`session.compact`,
`turn.complete`, `session.start`, …) and reach the host through the mods
API (`$`): HTTP, the clock, settings, the UI and more. What a mod can
extend, with every event, API namespace and render site, is written up in
[docs/mods-extension-features.en.md](docs/mods-extension-features.en.md)
([日本語](docs/mods-extension-features.ja.md)).

## Mods

| Mod | What it does |
| --- | --- |
| [decision-compaction](mods/decision-compaction/README.md) | Answers `session.compact` with the conversation itself, less the tool calls and results a System One decision model (TypeSafe Jev, Cloudflare Clef, Codiv OpenJev, Perplexity pplx-decider, OpenAI GPT-6 Luna, or Jev through OpenRouter, decisions-api.dev or decisionapi.net) judges no longer needed. Falls back to the built-in summary on any failure. |
| [model-gateway-rc](mods/model-gateway-rc/README.md) | Keeps a session on `api.anthropic.com` until Remote Control has registered, then routes it through a local Model Gateway, and back whenever the gateway stops answering. |

Each mod has its own README with its options, limits and the data it sends
off the machine. Read that section before enabling a mod on a session
whose content must stay local.

## Install

This repository is a Claude Code plugin marketplace. On Claude Code 2.1.275
or later one command adds the marketplace and installs a mod:

```sh
claude plugin install decision-compaction --marketplace zchee/claude-code-mods
claude plugin install model-gateway-rc --marketplace zchee/claude-code-mods
```

Or in two steps, which also works from inside a session as `/plugin`:

```sh
claude plugin marketplace add zchee/claude-code-mods
claude plugin install decision-compaction@claude-code-mods
```

To try a mod from a checkout without installing it:

```sh
claude --plugin-dir mods/decision-compaction
```

Options are read from settings under `pluginConfigs` and appear in
`/config`. The package is not published to npm; a mod is only ever
installed through Claude Code.

## Development

Requirements: [pnpm](https://pnpm.io) 12.9.1 (the `packageManager` field;
Corepack or pnpm itself downloads it), Claude Code 2.1.292 or later on
`PATH`, and [Bun](https://bun.sh) only for the live smoke script.

```sh
pnpm install
pnpm run check   # validate + typecheck + test, every mod
```

| Script | What it runs |
| --- | --- |
| `pnpm run validate` | `claude plugin validate --strict` on the marketplace and on every mod. |
| `pnpm run typecheck` | `tsc -p mods`: every mod's hooks and tests against the plugin API snapshot in `mods/types`. |
| `pnpm run test` | `claude plugin test` on every mod. Tests answer HTTP, the clock, files and settings from memory and never reach a network. |
| `pnpm run types:update` | After a Claude Code upgrade: loads every mod so the installed version writes fresh declarations, runs `types:sync`, and updates the version in this README. |
| `pnpm run types:sync` | Only the copy step: refreshes `mods/types` from the declarations a mod already loaded by the installed Claude Code holds. |
| `pnpm run live:decision-compaction` | Sends one synthetic request to every decision provider whose key is in the environment. Prints no secret. |

`scripts/each-mod.bash` runs a command once per folder under `mods/` that
has a `.claude-plugin/plugin.json`, and stops at the first failure.

### The plugin API snapshot

Claude Code writes the type declarations for its plugin API only when it
loads a mod, into that mod's git-ignored `.claude-plugin/types/`. The copy
in `mods/types/` lets `tsc -p mods` check every mod without starting
Claude Code, and names the version it came from (2.1.295 today). After
upgrading Claude Code, run `pnpm run types:update`, then `pnpm run check`,
and commit the new snapshot with whatever it breaks.

### Layout

```text
.claude-plugin/marketplace.json   the marketplace: one entry per mod
mods/<mod>/.claude-plugin/        plugin.json (manifest, options schema)
mods/<mod>/hooks/                 hooks.json and the TypeScript modules
mods/<mod>/tests/                 claude plugin test suites
mods/types/                       plugin API declarations (snapshot)
mods/tsconfig.json                one tsc project over every mod
scripts/                          each-mod.bash, sync-types.bash,
                                  update-types.bash, live smoke
docs/                             what a mod can extend (en, ja)
```

## Contributing

Issues and pull requests are welcome at
[zchee/claude-code-mods](https://github.com/zchee/claude-code-mods). Run
`pnpm run check` before opening a pull request. This project follows the
[Contributor Covenant](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE). Copyright Koichi Shiraishi.
