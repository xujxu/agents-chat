#!/usr/bin/env bash
# Upgrade a source checkout, then run the NEW installer and its voice menu.
# For an installation predating this script: git pull --ff-only, then run
# sudo ./scripts/deploy.sh --no-pull.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."
git pull --ff-only
exec bash "$script_dir/deploy.sh" "$@" --no-pull
