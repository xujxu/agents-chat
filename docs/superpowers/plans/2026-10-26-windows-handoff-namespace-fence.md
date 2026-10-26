# Windows Handoff Namespace Fence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every durable handoff artifact blocks ordinary lock acquisition, release and reconciliation before any handoff publisher exists.

**Architecture:** Reserve a Windows-only, case-insensitive `inactive-handoff-*.json` maintenance namespace. Reuse the existing shared maintenance classifier and existing ownership-preservation tests; introduce no parser, publication authority or public admission exception.

**Tech Stack:** Node.js ESM, node:test, existing Windows private-test harness, GitHub Actions.

---

## Scope and file map

This is the first independently testable prerequisite of the approved
`docs/superpowers/specs/2026-10-26-windows-stopped-history-handoff-design.md`.
It is deliberately a separate plan from native publication, state continuity
and public routing: each of those needs its own implementation plan and
acceptance evidence before enabling the next capability.

- Modify `scripts/deployment/state.mjs`, `serviceMaintenanceEntry` near line
  365: one shared Windows-only namespace fence for all three ordinary paths.
- Modify `tests/deployment-state.test.mjs`, marker table near line 35:
  exercise prepared, committed, snapshot, state-transition and abandoned
  records through existing real private-directory and lock fixtures.
- Modify this plan: record Actions red/green evidence and completed steps.

Record names reserved by this prerequisite are
`inactive-handoff-<attempt-guid>-<kind>.json`, with kinds `prepared`,
`committed`, `snapshot`, `state-transition` and `abandoned`. The gate
intentionally blocks malformed/unknown kinds too; only an explicit future
handoff verifier may distinguish valid authority. Empty or malformed bytes
must not make ordinary admission succeed.

## Task 1: Establish failing ownership-preservation contracts

- [ ] Add the following entries to the Windows-only array immediately after
  the existing archived history-complete marker in
  `tests/deployment-state.test.mjs`:

```js
      'inactive-handoff-12345678-1234-1234-1234-123456789abc-prepared.json',
      'inactive-handoff-12345678-1234-1234-1234-123456789abc-committed.json',
      'inactive-handoff-12345678-1234-1234-1234-123456789abc-snapshot.json',
      'inactive-handoff-12345678-1234-1234-1234-123456789abc-state-transition.json',
      'inactive-handoff-12345678-1234-1234-1234-123456789abc-abandoned.json',
      'inactive-handoff-malformed.json'
```

The existing table expands each Windows name to lowercase and uppercase.
Its test body already checks refused release, refused fresh acquisition,
blocked reconciliation, refusal even with `allowLiveRetirement`, and exact
owner bytes retained. Reuse it rather than duplicate its fixtures.

- [ ] Commit tests with the required session trailers and push:

```bash
git add tests/deployment-state.test.mjs
git commit -m "test: fence incomplete Windows handoff artifacts [skip ci]" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 2c456ed2-b6d1-499d-a65c-01eac852ed64"
git push
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_restore_only=true -f windows_contracts_only=true
```

- [ ] Watch the returned run ID with `gh run watch <returned-id> -R
  xujxu/agents-chat --interval 180 --exit-status`. Expected: Windows
  Contracts fails because release unexpectedly succeeds for the new marker.
  Download that job's logs and confirm this assertion, not an infrastructure
  failure. Do not run the harness or Node locally.

## Task 2: Add the shared maintenance fence

- [ ] In `serviceMaintenanceEntry`, immediately after the existing
  inactive-rollback predicate, add:

```js
    || (process.platform === 'win32'
      && entry.startsWith('inactive-handoff-') && entry.endsWith('.json'))
```

The function already lowercases Windows names. Do not change Linux behavior,
`acquireLock`, `releaseLock`, reconciliation or their error messages.
They already share this classifier, so the new predicate must be sufficient.

- [ ] Commit the implementation with the required trailers and push:

```bash
git add scripts/deployment/state.mjs
git commit -m "fix: retain Windows handoff evidence behind maintenance fence [skip ci]" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 2c456ed2-b6d1-499d-a65c-01eac852ed64"
git push
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup \
  -f windows_restore_only=true -f windows_contracts_only=true
```

- [ ] Watch the returned run at 180-second intervals. Expected: complete
  Windows Contracts succeeds, including both casings of all six artifacts.
  Inspect downloaded job logs for the new test titles and passing results.
  Never infer coverage solely from a green run.

- [ ] Record both SHAs, run IDs, actual job IDs and observed red/green
  assertions here; commit and push the evidence with required trailers.
  Keep the already-running full matrix intact: it validates its own earlier
  SHA, not this new behavior.

## Self-review and remaining gates

This prerequisite implements only the design's conservative ordinary-path
fence. It grants no handoff authority and changes no saved engine closure.
The test uses malformed/empty evidence intentionally, so a parser cannot
accidentally turn incomplete publication into an idle control directory.

The next separately planned gate is strict prepared/committed record
decoding plus native exact-owner publication. State snapshot/transition,
dead-owner lock retirement, handoff-aware release/reconciliation and public
inactive transaction routing stay unsupported until their respective plans
and native death-boundary acceptance are complete. Final acceptance still
requires actual repeat-update/rollback and a latest same-SHA dual-platform
matrix.
