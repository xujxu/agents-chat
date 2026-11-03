#!/usr/bin/env bash
# See README "Deployment (Linux)". Example: sudo ./scripts/update.sh --project-dir /opt/agents-chat
exec "$(dirname "${BASH_SOURCE[0]}")/deploy/run.sh" update "$@"
