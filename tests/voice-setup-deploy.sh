#!/usr/bin/env bash
# Run only inside an isolated Actions container with mocked deployment commands.
set -euo pipefail
root="$(mktemp -d /tmp/voice-deploy-test.XXXXXX)"
mkdir -p "$root/app/scripts" "$root/bin" /etc/systemd/system
cp -a scripts/configure-voice.mjs scripts/deploy.sh scripts/agents-chat.service scripts/voice "$root/app/scripts/"
export MOCK_LOG="$root/commands.log"
export PATH="$root/bin:$PATH"
printf '# existing service\n' > /etc/systemd/system/agents-chat.service
cat > "$root/bin/npm" <<'SH'
#!/bin/sh
echo "npm $*" >> "$MOCK_LOG"
SH
cat > "$root/bin/systemctl" <<'SH'
#!/bin/sh
echo "systemctl $*" >> "$MOCK_LOG"
echo "mock service status"
SH
cat > "$root/bin/git" <<'SH'
#!/bin/sh
echo "git $*" >> "$MOCK_LOG"
SH
cat > "$root/bin/curl" <<'SH'
#!/bin/sh
test "${MOCK_HEALTH:-ok}" = ok
SH
chmod +x "$root/bin/"*
original='OTHER=keep
VOICE_ENABLED=1
VOICE_WHISPER_PATH=/old/engine
VOICE_MODEL_PATH=/old/model'
printf '%s\n' "$original" > "$root/app/.env.local"
bash "$root/app/scripts/deploy.sh" --no-install --non-interactive --wait 1
test "$(cat "$root/app/.env.local")" = "$original"
test "$(grep -c '^git pull --ff-only$' "$MOCK_LOG")" = 1
bash "$root/app/scripts/deploy.sh" --no-pull --no-install --voice disabled --wait 1
grep -qx VOICE_ENABLED=0 "$root/app/.env.local"
printf '%s\n' "$original" > "$root/app/.env.local"
if MOCK_HEALTH=fail bash "$root/app/scripts/deploy.sh" --no-pull --no-install --voice disabled --wait 1; then
  echo "Expected activation failure"; exit 1
fi
test "$(cat "$root/app/.env.local")" = "$original"
if find "$root/app" -maxdepth 1 -name '.voice-setup-receipt.*' | grep -q .; then
  echo "Private deployment receipts leaked"; exit 1
fi
echo "Deployment preservation, re-exec, explicit disable and activation rollback passed."
