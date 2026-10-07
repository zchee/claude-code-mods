#!/usr/bin/env bash
# Copies the plugin API declarations Claude Code wrote into a loaded mod's
# git-ignored .claude-plugin/types/ into mods/types/, the snapshot that
# `tsc -p mods` checks every mod against without starting Claude Code.
#
# Claude Code writes the declarations only when it loads a mod, so load one
# first with the installed version, e.g. `claude --plugin-dir mods/<mod>`.
# A source written by another version than the installed one is refused, so
# the snapshot always names the version it came from.
#
# claude-code-mcp is not copied: Claude Code fills it with the MCP tools of
# the session that loaded the mod, which belong to that person's setup, not
# to the repository.
set -euo pipefail

script_path=$(readlink -f -- "${BASH_SOURCE[0]}")
cd "${script_path%/*}/.."

installed=$(claude --version | cut -d' ' -f1)

if [ "$#" -gt 0 ]; then
  src="${1%/}/.claude-plugin/types"
else
  src=
  for candidate in mods/*/.claude-plugin/types; do
    if [ -f "$candidate/claude-code/index.d.ts" ]; then
      src=$candidate
      break
    fi
  done
fi

if [ -z "$src" ] || [ ! -f "$src/claude-code/index.d.ts" ]; then
  echo "$0: no declarations to copy; load a mod first: claude --plugin-dir mods/<mod>" >&2
  exit 1
fi

written=$(sed -n '1s|^// Written by Claude Code \(.*\)\.$|\1|p' "$src/claude-code/index.d.ts")
if [ "$written" != "$installed" ]; then
  echo "$0: $src was written by Claude Code ${written:-unknown}, installed is $installed; load the mod again first" >&2
  exit 1
fi

for name in claude-code claude-code-tools; do
  mkdir -p "mods/types/$name"
  cp "$src/$name/index.d.ts" "mods/types/$name/index.d.ts"
done

echo "mods/types: Claude Code $installed declarations from $src"
