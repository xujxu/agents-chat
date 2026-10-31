#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Linux deploy requires Node.js 24 on the controller PATH. Install Node.js before retrying; no deployment was started.' >&2
  exit 1
fi
exec env -u NODE_OPTIONS -u NODE_PATH node "$script_dir/deployment/linux-deploy-entry.mjs" "$@"
