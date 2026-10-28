# Fresh Restart Owner Publication Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish only the exact live restart owner's create-only owner file inside its retained fresh directory, without committed or state authority.

**Architecture:** Continue the existing approved bound-handoff design through a separate twentieth fixture boundary. Retain the same tenth Node and native bridge across preparation, directory creation and owner publication. Keep the earlier normal-directory duplicate refusal and actual incomplete-directory death boundaries unchanged.

**Tech Stack:** PowerShell native retained file/directory handles, Node.js bounded transport, Windows GitHub Actions only.

---

### Task 1: Add a distinct owner-publication fixture

**Files:**
- Create: `tests/deployment-windows-history-handoff-restart-owner.ps1`
- Create: `tests/deployment-windows-restart-owner-publication.mjs`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-restart-preparation.mjs`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Create: `tests/deployment-windows-restart-owner-controller.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add `restart-owner-history` after the nineteen existing boundaries.
  Run all its ancestor publication/death/independent-readonly steps exactly
  as for the normal fresh-directory path. Select
  `resume-restart-owner-history` only after the ninth six-record observer.
- [ ] Keep preparation and directory creation in the same live native
  scope. Continue directory mode skips its duplicate poison only for this
  new owner continuation; the original eighteenth mode still tests it.
- [ ] After the actual directory response, emit
  `INACTIVE_HISTORY_RESTART_DIRECTORY_LIVE` with actual Node/bridge
  identities, the retained preparation descriptor and native directory
  identity. Host checks those identities against the earlier live frame,
  checks the exact empty directory and preparation digest, then sends:

```text
{"type":"publish-owner"}
```

- [ ] The native fixture accepts only that exact command, loads
  `windows-stopped-history-handoff-restart-owner.ps1`, checks refusal
  without its independent role, then publishes through
  `Publish-AgentsChatStoppedHistoryHandoffRestartLockOwner`.
- [ ] Require this exact result shape; each descriptor is the actual
  pinned five-field `path/dev/ino/bytes/sha256` descriptor:

```javascript
{
  status: 'restart-lock-owner',
  attemptId: record.attemptId,
  prepared: descriptor,
  directory: directoryIdentity,
  owner: ownerDescriptor,
  runtimeAuthority: false,
  lockAuthority: false,
}
```

- [ ] Compare actual owner bytes to `JSON.stringify(record.newOwner)`,
  all seven expected owner fields, native descriptor/hash/dev/ino and the
  exact directory inventory `['owner.json']`. Native duplicate publication
  must poison and retain the same owner/directory identities and bytes.
- [ ] Ordinary readers/acquire/release remain refused while this exact
  owner is actually live. Seven records, original state and completion
  remain byte/identity-exact. Only fixture cleanup unlinks the verified
  owner before removing the exact empty directory and seven records.
- [ ] Keep every native/host command at 45 seconds, bridge exit at 15
  seconds and each acknowledged host stage at 120 seconds. Owner adds a
  third explicit stage, not a larger existing response timeout.
- [ ] Commit/push the fixture with `[skip ci]`, then dispatch:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
```

Expected valid red: missing native restart-owner module at the twentieth
boundary, not a protocol timeout or fixture dependency failure.

### Task 2: Publish and retain the exact native owner

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-restart-owner.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-restart-lock.ps1`

- [ ] Add the independent `HistoryHandoffRestartOwnerPublisher` role.
  Derive owner bytes only from the retained seventh preparation's native
  binding, never from JS JSON or the original retired owner's cache.
- [ ] `Publish-AgentsChatStoppedHistoryHandoffRestartLockOwner` takes
  `Context`, `ControllerPid`, `ControllerIdentity`. Require the actual
  retained watched controller, no prior owner cache and the exact empty
  pinned fresh directory. Fully observe the settled six-record ancestry,
  publish `lock\owner.json` with `WindowsPrivateFile.Publish`, retain its
  native file and descriptor, then fully reobserve ancestry and strict
  fresh lock binding. Any failure poisons the scope and preserves evidence.
- [ ] Extend the nonrecursive fresh-lock assertion only when both the
  explicit owner-publisher role and retained actual owner file/descriptor
  exist. Re-derive exact live owner bytes through the pinned preparation,
  compare native file bytes/descriptor, require one lowercase `owner.json`
  child, and recheck the directory handle. Empty mode still rejects all
  children. Do not change the original retired lock cache or ordinary
  maintenance gates.
- [ ] No fresh committed record, snapshot, state intent, state write,
  worker start, task mutation, release or dead-owner adoption is introduced.
- [ ] Push implementation and dispatch focused plus same-SHA Contracts:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_restore_only=true -f windows_contracts_only=true
```

- [ ] Match all 39 actual timestamped receipts, including:

```text
PASS: native restart owner publication pins only its exact fresh live owner while ordinary authority and duplicate publication remain refused
```

- [ ] Commit accepted evidence. Actual owner-publisher death remains the
  next independent gate before fresh committed capability.

### Aggregate-budget investigation

At `92fba2725400c0d9e9d5c2ddcce006f96c06a014`, run `40636493388`,
job `122644553806`, was cancelled by the 90-minute aggregate limit at
`2026-10-28T06:41:16.3722229Z`. This is not a valid missing-module red.
The prior normal directory receipt passed at `06:24:37.9444506Z` and
actual incomplete-directory death passed at `06:33:09.7158996Z`.
The new owner's ninth six-record observer passed at
`06:39:32.7463905Z`, before cancellation during the final live fixture.
No native 45-second response timeout was reported.

- [ ] Split only the cumulative fixture scheduling into two native
  Windows jobs: `baseline` covers history through original lock
  settlement; `restart` covers successor preparation through fresh owner
  publication. Both run their own complete runtime/task setup and every
  selected boundary's full original ancestor/death chain.
- [ ] Default direct fixture invocation still selects `all`; reject
  unknown shard names. Earlier summary receipts are emitted only by the
  baseline/all selection that actually runs their original boundaries.
- [ ] Keep aggregate 90-minute and native/actor/exit bounds unchanged.
  Preserve actual stdout receipt strings from each successful shard in
  distinct artifacts. A dependent acceptance job requires both artifacts
  and all 39 original exact receipts; neither shard alone can pass the
  full acceptance gate.
- [ ] Push and repeat the same focused dispatch to obtain valid owner
  module red without repeating all twenty boundaries serially in one job.
