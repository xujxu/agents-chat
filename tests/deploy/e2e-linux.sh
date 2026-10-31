#!/usr/bin/env bash
# End-to-end deployment test on Linux with systemd. Run as root from the repo root (CI only).
set -euo pipefail

SRC=$(pwd)
T=/srv/e2e
ROOT=$T/deploy
OLD=$T/old
PORT=3010
mkdir -p "$T"

step() { echo; echo "=== $* ==="; }
dump() {
  echo "--- state.json"; cat "$ROOT/state.json" 2>/dev/null || true
  echo "--- unit"; cat /etc/systemd/system/agents-chat.service 2>/dev/null || true
  echo "--- journal"; journalctl -u agents-chat -n 80 --no-pager || true
  ls -la "$ROOT" "$ROOT/releases" "$ROOT/backups" 2>/dev/null || true
}
fail() { echo "FAIL: $*"; dump; exit 1; }
trap 'fail "unexpected error on line $LINENO"' ERR

version() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" | node -pe 'JSON.parse(require("fs").readFileSync(0)).version'; }
wait_version() { # expected sha
  for _ in $(seq 1 90); do [[ "$(version 2>/dev/null || true)" == "$1" ]] && return 0; sleep 2; done
  fail "expected version $1, got $(version 2>/dev/null || echo none)"
}
marker() { node "$SRC/tests/deploy/marker.mjs" "$@"; }
state() { node -pe "const s=JSON.parse(require('fs').readFileSync('$ROOT/state.json'));$1"; }
d() { "$SRC/scripts/$1.sh" --project-dir "$ROOT" "${@:2}"; }
expect_exit() { # code, command...
  local want=$1; shift
  set +e; trap - ERR; "$@"; local got=$?; set -e; trap 'fail "unexpected error on line $LINENO"' ERR
  [[ $got == "$want" ]] || fail "expected exit $want, got $got: $*"
}

step "fixtures: bare origin and test commits"
eval "$("$SRC/tests/deploy/make-commits.sh" "$SRC" "$T/origin.git" "$T/work")"

step "fixtures: main-style checkout running as the systemd service"
git clone -q "$T/origin.git" "$OLD"
printf 'NEXTAUTH_SECRET=e2e-secret\nNEXTAUTH_URL=http://localhost:%s\n' "$PORT" > "$OLD/.env.local"
(cd "$OLD" && npm ci --no-audit --no-fund && npm run build) > "$T/old-build.log" 2>&1 || { tail -50 "$T/old-build.log"; fail "old build"; }
cat > /etc/systemd/system/agents-chat.service <<EOF
[Unit]
Description=agents-chat (legacy layout)
[Service]
User=root
WorkingDirectory=$OLD
EnvironmentFile=-$OLD/.env.local
Environment=NODE_ENV=production
Environment=PATH=$(dirname "$(command -v node)"):/usr/bin:/bin
ExecStart=$(command -v npm) start
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now agents-chat
wait_version null
marker write "$OLD/.data/chats.db" m1
old_status=$(git -C "$OLD" status --porcelain)

step "1. migrate the existing checkout"
d deploy --import-from "$OLD"
wait_version "$BASE"
marker has "$ROOT/shared/.data/chats.db" m1 || fail "marker m1 missing after migration"
[[ "$(git -C "$OLD" status --porcelain)" == "$old_status" ]] || fail "old checkout changed"
[[ -f "$OLD/.data/chats.db" && -f "$OLD/.env.local" ]] || fail "old checkout files moved"
grep -q "^User=root" /etc/systemd/system/agents-chat.service || fail "unit User not kept"
grep -q "^WorkingDirectory=$ROOT/current" /etc/systemd/system/agents-chat.service || fail "unit not re-pointed"
ls "$ROOT"/backups/migration-*/agents-chat.service >/dev/null || fail "old unit not backed up"

step "2. upgrade (reusing dependencies)"
d update --revision "$V2" --no-install
wait_version "$V2"
marker has "$ROOT/shared/.data/chats.db" m1 || fail "marker m1 missing after upgrade"

step "3. a build failure leaves the running version untouched"
( while true; do version >> "$T/probe.log" 2>&1 || echo DOWN >> "$T/probe.log"; sleep 1; done ) &
probe=$!
expect_exit 1 d update --revision "$BROKEN" --no-install
kill $probe
grep -q DOWN "$T/probe.log" && fail "app was down during a failed build"
[[ "$(state 's.lastResult.step')" == build ]] || fail "lastResult.step should be build"
wait_version "$V2"

step "4. a failing health check rolls back code and data"
expect_exit 1 d update --revision "$UNHEALTHY" --no-install --wait 60
[[ "$(state 's.lastResult.outcome')" == rolled-back ]] || fail "expected rolled-back"
wait_version "$V2"
marker has "$ROOT/shared/.data/chats.db" m1 || fail "marker m1 missing after rollback"

step "5. restore the previous release and its data"
marker write "$ROOT/shared/.data/chats.db" m2
expect_exit 2 d restore
d restore --accept-data-loss
wait_version "$BASE"
marker has "$ROOT/shared/.data/chats.db" m1 || fail "marker m1 missing after restore"
if marker has "$ROOT/shared/.data/chats.db" m2; then fail "marker m2 should be gone after restore"; fi

step "6. an interrupted update is undone by the next run"
d update --revision "$V3" --no-install --wait 120 > "$T/crash.log" 2>&1 &
pid=$!
for _ in $(seq 1 600); do
  [[ "$(state 's.pending && s.pending.step' 2>/dev/null)" == health ]] && break
  sleep 0.5
done
[[ "$(state 's.pending && s.pending.step')" == health ]] || { cat "$T/crash.log"; fail "update never reached the health step"; }
core=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).pid' "$ROOT/deploy.lock")
kill -9 "$core"
wait "$pid" || true
while kill -0 "$core" 2>/dev/null; do sleep 0.2; done

step "7. re-run recovers; -NoWait marks the release unverified"
d update --revision "$V3" --no-install --wait 0
wait_version "$V3"
[[ "$(state 's.verified')" == false ]] || fail "expected verified=false after --wait 0"
[[ "$(state 's.pending')" == null ]] || fail "pending not cleared"
d update --status --json | node -e 'const s=JSON.parse(require("fs").readFileSync(0));if(!s.ok||s.current===null)process.exit(1)'

step "7b. --no-install is refused after a lock change"
expect_exit 2 d update --revision "$LOCKCHANGE" --no-install
wait_version "$V3"

step "retention: at most 3 releases"
[[ $(ls "$ROOT/releases" | wc -l) -le 3 ]] || fail "more than 3 releases kept"

trap - ERR
dump
echo "Linux deployment E2E passed."
