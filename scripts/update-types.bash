#!/usr/bin/env bash
# Brings the plugin API snapshot up to the installed Claude Code: makes it
# write fresh declarations into every mod, copies them into mods/types/ with
# sync-types.bash, and puts the new version into the README.
#
# Claude Code writes the declarations only when it loads a mod; `claude
# plugin validate` and `claude plugin test` do not. A print-mode run of a
# built-in slash command loads the mod and exits without a model turn.
# --strict-mcp-config keeps the user's MCP servers out of the run and
# --no-session-persistence keeps it out of the session history. It needs a
# logged-in Claude Code, like any other session.
#
# Every mod is loaded, not only the one the snapshot is copied from, so each
# mod's own .claude-plugin/types/ matches the installed version too.
set -euo pipefail

script_path=$(readlink -f -- "${BASH_SOURCE[0]}")
cd "${script_path%/*}/.."

installed=$(claude --version | cut -d' ' -f1)

first=
for manifest in mods/*/.claude-plugin/plugin.json; do
  if [ ! -f "$manifest" ]; then
    echo "$0: no mod found under mods/" >&2
    exit 1
  fi
  mod=${manifest%/.claude-plugin/plugin.json}
  declarations=$mod/.claude-plugin/types/claude-code/index.d.ts

  echo "==> load $mod with Claude Code $installed"
  if ! output=$(claude --plugin-dir "$mod" --strict-mcp-config --no-session-persistence -p '/cost' </dev/null 2>&1); then
    printf '%s\n' "$output" >&2
    echo "$0: Claude Code failed to load $mod" >&2
    exit 1
  fi

  written=
  if [ -f "$declarations" ]; then
    written=$(sed -n '1s|^// Written by Claude Code \(.*\)\.$|\1|p' "$declarations")
  fi
  if [ "$written" != "$installed" ]; then
    printf '%s\n' "$output" >&2
    echo "$0: loading $mod left $declarations at Claude Code ${written:-none}, expected $installed" >&2
    exit 1
  fi

  first=${first:-$mod}
done

bash scripts/sync-types.bash "$first"

version=${installed//./\\.}
perl -pi -e "s/(Claude(?:%20| )Code(?:%20| ))\d+\.\d+\.\d+/\${1}$installed/g if /img\.shields\.io\/badge\/plugin%20API/; s/\(\d+\.\d+\.\d+ today\)/($installed today)/" README.md
if ! grep -q "plugin%20API-Claude%20Code%20$version-" README.md; then
  echo "$0: README.md has no plugin API badge to update" >&2
  exit 1
fi
echo "README.md: plugin API badge names Claude Code $installed"
