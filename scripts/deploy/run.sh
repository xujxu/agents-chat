#!/usr/bin/env bash
# Shared launcher for scripts/{deploy,update,restore}.sh: finds Node.js and runs core.mjs.
set -euo pipefail

(( EUID == 0 )) || { echo "Run with sudo (needs systemctl access)." >&2; exit 2; }

# Under sudo, user-local Node.js installs (nvm, fnm, volta) are not on PATH.
if ! command -v node >/dev/null 2>&1; then
  home_dir="${SUDO_USER:+$(getent passwd "$SUDO_USER" | cut -d: -f6)}"
  home_dir="${home_dir:-$HOME}"
  for dir in \
    "$(ls -d "$home_dir"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -n1)" \
    "$(ls -d "$home_dir"/.local/share/fnm/node-versions/*/installation/bin 2>/dev/null | sort -V | tail -n1)" \
    "$home_dir/.volta/bin"; do
    if [[ -n "$dir" && -x "$dir/node" ]]; then export PATH="$dir:$PATH"; break; fi
  done
fi
command -v node >/dev/null 2>&1 || { echo "Node.js 24 not found on PATH." >&2; exit 2; }

exec node "$(dirname "${BASH_SOURCE[0]}")/core.mjs" "$@"
