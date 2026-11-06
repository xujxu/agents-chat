#!/usr/bin/env bash
# Share the Teams bot with colleagues, or stop sharing it, and update TEAMS_ALLOWED_USERS.
# See docs/teams-bot.md "Add or remove colleagues with one command". Restarting needs root
# (sudo); pass --no-restart otherwise. Example:
#   sudo ./scripts/teams-share.sh add alice@contoso.com --project-dir /opt/agents-chat
set -euo pipefail
command -v node >/dev/null 2>&1 || { echo "Node.js 24 not found on PATH." >&2; exit 2; }
exec node "$(dirname "${BASH_SOURCE[0]}")/teams-share/cli.mjs" "$@"
