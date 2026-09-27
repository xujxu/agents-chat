# Main Baseline Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. On this host, execution belongs to the operator; the assistant must not run builds or start services. The previously established inline fallback applies when these sub-skills are unavailable.

**Goal:** Deploy the pinned nonvoice main revision with a recoverable PoC backup, ready for a separate interactive voice upgrade.

**Architecture:** Keep the existing source checkout and deploy script. Stop the service for a consistent private backup, clear only legacy voice settings, and build main with the existing Node installation. Keep the current systemd drop-in and a no-build rollback path.

**Tech Stack:** Git, Bash, GNU coreutils, systemd, Node.js 24, npm, Next.js.

---

## Scope and files

This is an operator runbook, not an installer change. Execute blocks separately
in the operator's terminal as `xujx`; each uses a subshell so failure does not
close that terminal. Do not pipe deploy output through `tee`: later voice
configuration needs a real interactive terminal.

- Deployment checkout: `/home/xujx/wa/agents-chat`.
- Private backup: `/home/xujx/wa/agents-chat-pre-main-20260927`.
- New deployment branch: `deploy/main-baseline-20260927`.
- Current branch `deploy/mobile-ux-voice` is retained.
- Runtime files: `.data`, `.env.local`, `agents.json`, `.next`, `node_modules`.
- Service files: `/etc/systemd/system/agents-chat.service` and its `.d` directory.
- `/etc/agents-chat.env` was absent during inspection. The commands stop if
  this or another runtime environment file appears; inspect and extend backup
  coverage before continuing rather than ignoring an unexpected override.

No backup or deployment block has been executed by the assistant.

## Task 1: Back up the stopped PoC

- [ ] Run this block. It refuses to overwrite a previous backup. It restarts
  the unchanged PoC after a successful backup, or if copying fails after stop.
  It changes no application source or environment settings.

```bash
(
set -euo pipefail
cd /home/xujx/wa/agents-chat
test "$(git rev-parse HEAD)" = c6319933c870e9a2d5364f27d8df6bb54ef1b7d7
test "$(git branch --show-current)" = deploy/mobile-ux-voice
test -z "$(git status --porcelain)"
git cat-file -e '638c553c62406dbb7e6b5aeb41cdddf4cd6de179^{commit}'
if git show-ref --verify --quiet refs/heads/deploy/main-baseline-20260927; then
  echo "STOP: target deployment branch already exists." >&2
  exit 1
fi
sudo -v
sudo test ! -e /etc/agents-chat.env
for file in .env .env.production .env.production.local .env.development.local; do
  test ! -e "$file"
done
test -f .next/BUILD_ID
systemctl is-active --quiet agents-chat.service
df -h .
free -m
umask 077
mkdir /home/xujx/wa/agents-chat-pre-main-20260927
backup=/home/xujx/wa/agents-chat-pre-main-20260927
mkdir "$backup/app" "$backup/system"
git rev-parse HEAD > "$backup/source-commit"
git branch --show-current > "$backup/source-branch"
systemctl show agents-chat.service \
  --property=User,Group,ExecStart,WorkingDirectory,FragmentPath,DropInPaths \
  > "$backup/service-metadata"
printf 'absent\n' > "$backup/machine-env-state"
trap 'rc=$?; if ! sudo systemctl start agents-chat.service; then echo "ERROR: PoC restart failed; inspect systemctl status." >&2; exit 1; fi; exit "$rc"' EXIT
sudo systemctl stop agents-chat.service
test "$(systemctl show agents-chat.service --property=ActiveState --value)" = inactive
sudo cp -a -- .data .env.local agents.json .next node_modules "$backup/app/"
sudo cp -a -- /etc/systemd/system/agents-chat.service \
  /etc/systemd/system/agents-chat.service.d "$backup/system/"
sudo test -f "$backup/app/.next/BUILD_ID"
sudo test -f "$backup/system/agents-chat.service.d/runtime.conf"
sudo du -sh "$backup"
touch "$backup/COMPLETE"
sudo systemctl start agents-chat.service
systemctl is-active --quiet agents-chat.service
trap - EXIT
printf 'Backup complete; original PoC restarted: %s\n' "$backup"
)
```

- [ ] Expected: a roughly 2-3 GB private backup, `COMPLETE` marker and active
  original service. Retain the terminal output but do not share environment
  file contents. A partial backup without `COMPLETE` is not a recovery point.
- [ ] Before the next block, inspect the completion result. Do not rerun this
  block against the same backup directory. If interrupted, inspect service
  state and backup completion before deciding whether to resume.

## Task 2: Deploy the pinned nonvoice main

- [ ] Avoid concurrent chat activity during this maintenance interval.
  Run only after Task 1 succeeds. This block strips `VOICE_*` assignments from
  `.env.local`, preserving all other settings. Existing binary/model files
  remain backed up and on disk.

```bash
(
set -euo pipefail
cd /home/xujx/wa/agents-chat
test -f /home/xujx/wa/agents-chat-pre-main-20260927/COMPLETE
test "$(git rev-parse HEAD)" = c6319933c870e9a2d5364f27d8df6bb54ef1b7d7
test -z "$(git status --porcelain)"
sudo -v
sudo test ! -e /etc/agents-chat.env
for file in .env .env.production .env.production.local .env.development.local; do
  test ! -e "$file"
done
sudo systemctl stop agents-chat.service
test "$(systemctl show agents-chat.service --property=ActiveState --value)" = inactive
git switch -c deploy/main-baseline-20260927 638c553c62406dbb7e6b5aeb41cdddf4cd6de179
sed -i -E '/^[[:space:]]*(export[[:space:]]+)?VOICE_[A-Za-z0-9_]*[[:space:]]*=/d' .env.local
sudo env PATH=/home/xujx/.local/lib/node-v24.20.0-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  bash ./scripts/deploy.sh --no-pull
test "$(git rev-parse HEAD)" = 638c553c62406dbb7e6b5aeb41cdddf4cd6de179
test "$(systemctl show agents-chat.service --property=User --value)" = xujx
systemctl is-active --quiet agents-chat.service
systemctl show agents-chat.service --property=User,Group,ExecStart,ActiveState,SubState
printf 'Pinned main deployed; browser acceptance is still required.\n'
)
```

- [ ] Expected: existing script completes dependency install, build, restart,
  and its health check. Service still runs as `xujx` through the retained
  Node 24 runtime drop-in. On error, stop here and retain the error output.
  Do not start a partially built application manually.
- [ ] In a fresh browser page through the existing HTTPS site, confirm login,
  existing chat history, one ordinary chat exchange, and no microphone button.
  Record failures explicitly. Do not proceed to voice upgrade based only on
  a successful build or the Git revision.

## Task 3: Recover only if main deployment fails

Use this only before accepting new main-version chat activity. Restoring the
saved database reverts messages written since Task 1. If there is new activity,
stop and decide how to retain it before database restoration. The failed data
is moved aside, not deleted.

- [ ] Run the recovery block once. It refuses a preexisting failed-state
  directory and stops if unrelated source edits or machine overrides appeared.
  It does not rebuild or reinstall.

```bash
(
set -euo pipefail
cd /home/xujx/wa/agents-chat
backup=/home/xujx/wa/agents-chat-pre-main-20260927
test -f "$backup/COMPLETE"
test "$(cat "$backup/source-commit")" = c6319933c870e9a2d5364f27d8df6bb54ef1b7d7
test -z "$(git status --porcelain)"
test "$(git rev-parse deploy/mobile-ux-voice)" = c6319933c870e9a2d5364f27d8df6bb54ef1b7d7
sudo -v
sudo test ! -e /etc/agents-chat.env
mkdir -m 700 /home/xujx/wa/agents-chat-failed-main-20260927
failed=/home/xujx/wa/agents-chat-failed-main-20260927
sudo systemctl stop agents-chat.service
test "$(systemctl show agents-chat.service --property=ActiveState --value)" = inactive
git switch deploy/mobile-ux-voice
for file in .next node_modules .data .env.local; do
  if test -e "$file"; then sudo mv -- "$file" "$failed/"; fi
done
sudo cp -a -- "$backup/app/.data" "$backup/app/.next" \
  "$backup/app/node_modules" "$backup/app/.env.local" "$backup/app/agents.json" .
sudo mv -- /etc/systemd/system/agents-chat.service "$failed/"
sudo mv -- /etc/systemd/system/agents-chat.service.d "$failed/"
sudo cp -a -- "$backup/system/agents-chat.service" \
  "$backup/system/agents-chat.service.d" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start agents-chat.service
systemctl is-active --quiet agents-chat.service
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 2 \
  --max-time 5 --output /dev/null http://localhost:3010/api/auth/providers
printf 'Original PoC restored; confirm login and chat history in browser.\n'
)
```

## Task 4: Gate the subsequent voice upgrade

- [ ] Keep main serving until browser acceptance is recorded.
- [ ] Classify candidate E2E run `36290112623`, failed job `108538447768`
  (iPhone WebKit). Voice run `36290112667` passed, but that does not supersede
  the failed E2E result. Resolve the failure or explicitly agree its limitation
  before authorizing the voice upgrade; main preparation can proceed.
- [ ] Identify an available trusted Linux Whisper package and its manifest
  checksum from Actions evidence. The old raw PoC runtime is not sufficient:
  `scripts/voice/install-package.mjs` requires `voice-package.json` and a
  trusted checksum. Do not schedule downtime or issue an enable command until
  the package is available. Automatic experimental downloads support SenseVoice,
  not Whisper.
- [ ] Prepare a second stopped-service backup for the accepted main state,
  including any newly accepted chats. Use a separate backup path and do not
  overwrite the original PoC backup.
- [ ] Use candidate `95594894566b3f99b0ac43267110b8db70d8faf9`, a new deployment
  branch, and its existing deploy script with `--no-pull` and verified package
  arguments. Do not pass `--voice keep`, preselect a model, or use
  `--non-interactive`. At the existing combined menu, option 3 enables Whisper;
  option 4 disables voice, and default keep leaves the clean baseline disabled.
- [ ] Before proceeding, disclose that explicit Whisper selection writes
  `standard`, not the old PoC's `legacy-low-memory`. Do not silently change
  the installer result to conceal this distinction.
- [ ] After activation, record the effective configuration and perform sequential
  physical microphone tests on desktop Chrome, iPhone Safari and iPhone Chrome:
  allow/deny permission, record/stop/transcribe, cancel/retry, edit inserted text,
  and send a message. Record failures; do not infer physical acceptance from CI.

Task 4 is a readiness gate, not an executable upgrade command. Its exact
package arguments and second-backup commands must be prepared from verified
package evidence and the then-current main deployment state. No installer
change or local assistant-run validation is authorized by this plan.
