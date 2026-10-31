#!/usr/bin/env bash
# Creates a bare origin from the current checkout plus test commits on branches.
# Prints KEY=sha lines for: BASE V2 BROKEN UNHEALTHY V3 LOCKCHANGE.
set -euo pipefail
src="$1"; origin="$2"; work="$3"
health=app/api/health/route.ts

git clone -q --bare "$src" "$origin"
git clone -q "$origin" "$work"
cd "$work"
git config user.email ci@example.com
git config user.name ci
base=$(git rev-parse HEAD)
echo "BASE=$base"

commit() { # name, then a command that edits the tree
  local name=$1; shift
  git checkout -q -B "t-$name" "$base"
  "$@"
  git commit -qam "test: $name" --allow-empty
  git push -q origin "t-$name"
  echo "${name^^}=$(git rev-parse HEAD)"
}
commit v2 true
commit broken sed -i 's/export async function GET() {/export async function GET() { const = ;/' "$health"
commit unhealthy sed -i 's/return NextResponse.json({ ok: true, version: readRevision() });/return NextResponse.json({ ok: false }, { status: 500 });/' "$health"
commit v3 true
commit lockchange sed -i 's/"lockfileVersion"/"lockfileVersion" /' package-lock.json
