#!/usr/bin/env bash
# Runs the given command once per mod, the mod's folder appended as the last
# argument, and stops at the first mod it fails for. A mod is a folder under
# mods/ with a .claude-plugin/plugin.json; mods/types has none and is skipped.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

script_path=$(readlink -f -- "${BASH_SOURCE[0]}")
cd "${script_path%/*}/.."

for manifest in mods/*/.claude-plugin/plugin.json; do
  if [ ! -f "$manifest" ]; then
    echo "$0: no mod found under mods/" >&2
    exit 1
  fi
  mod=${manifest%/.claude-plugin/plugin.json}
  echo "==> $* $mod"
  "$@" "$mod"
done
