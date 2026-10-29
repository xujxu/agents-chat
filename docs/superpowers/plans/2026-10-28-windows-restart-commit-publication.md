# Fresh Restart Commit Publication Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an exact create-only fresh committed record under the retained live restart owner, rejecting record-only copies and preserving original state.

**Architecture:** Continue the accepted normal live owner path, not either dead publication path. Bind the eighth native file to the seventh preparation, actual pinned owner/directory and current watched Node/bridge. Retained native proof is required; serialized records alone grant no capability, and state/task/runtime authority remains unimplemented.

**Tech Stack:** PowerShell native retained handles and strict JSON binding, Node.js bounded phase protocol, GitHub Actions only.

---

### Task 1: Add a separate live committed-publication boundary

**Files:**
- Create: `tests/deployment-windows-history-handoff-restart-commit.ps1`
- Create: `tests/deployment-windows-restart-commit-publication.mjs`
- Create: `tests/deployment-windows-restart-commit-controller.ps1`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-history-handoff-restart-owner.ps1`
- Modify: `tests/deployment-windows-restart-owner-publication.mjs`
- Modify: `tests/deployment-windows-restart-preparation.mjs`
- Modify: `tests/deployment-windows-restart-publication-progress.ps1`
- Modify: `tests/deployment-windows-restart-publication-progress.mjs`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Append `restart-committed-history` as boundary twenty-two. Retain the
  first twenty-one scenarios, including both actual death paths and the
  normal owner duplicate refusal. Continue owner mode skips only its
  duplicate poison while retaining the same tenth Node/native bridge.
- [ ] After exact live owner publication, emit
  `INACTIVE_HISTORY_RESTART_OWNER_LIVE` with actual identities, preparation
  and owner descriptors and directory identity. Host checks current live
  Node/bridge, matching preparation, exact owner digest/inventory, actual
  directory identity and absent fresh committed path before sending:

```text
{"type":"commit-restart"}
```

- [ ] Native fixture accepts only that exact command, loads
  `windows-stopped-history-handoff-restart-commit.ps1` and checks independent
  `HistoryHandoffRestartCommitter` refusal before valid publication through
  `Complete-AgentsChatStoppedHistoryHandoffRestartCommit`.
- [ ] Require both original full ancestor proof frames in order before
  the descriptor-only committed result; each response stays 45 seconds,
  the fourth host stage stays 120 seconds and bridge exit stays 15 seconds.
- [ ] Read the actual committed file and check this complete typed shape:

```javascript
{
  version: 1,
  phase: 'stopped-history-handoff-restart-committed',
  attemptId: record.attemptId,
  control,
  project: original.project,
  controlIdentity: original.controlIdentity,
  previousOperationId: original.previousOperationId,
  prepared,
  newOwner: record.newOwner,
  lockIdentity: directory,
  lock: owner,
  creator: {
    pid: process.pid, processIdentity: identity,
    bridgePid: ready.pid, bridgeIdentity: ready.processIdentity,
  },
  committedAt,
}
```

- [ ] Native pure assertion must reject a copied committed JSON/descriptor
  cache without the actual retained committed native file. Duplicate
  publication poisons and preserves the exact eighth file, owner and
  directory. Ordinary readers/acquire/release remain refused; original
  state/completion and all eight files retain bytes/identities.
- [ ] Push tests and run focused Actions. Establish missing native
  restart-commit module red at the new fourth phase, not a fixture timeout.

### Task 2: Bind an actual native eighth record

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-restart-commit.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`

- [ ] Derive all record fields from native retained preparation and owner
  proof; derive creator from the watched controller and actual current
  bridge. Native canonical committed time must be between preparation
  time and the current clock. Accept no caller-supplied committed JSON.
- [ ] Fully observe the settled ancestry before/after create-only
  publication. Pin the actual file and descriptor in
  `HistoryHandoffRestartCommitted`; preserve and poison on any failure.
- [ ] Add a nonrecursive strict committed assertion: explicit committer
  role, actual retained `WindowsPrivateFile`, exact path/hash/dev/ino/bytes,
  strict typed thirteen-field JSON, live exact owner/bridge and pinned
  directory/owner/preparation binding. It must not call a full ancestor
  getter from the namespace callback.
- [ ] Extend the namespace only for this actual retained committed cache
  through the strict assertion. Do not extend ordinary bootstrap request
  shapes or accept an eighth filename without private native proof.
- [ ] No snapshot, state-transition intent, state write, task/worker
  mutation, release, dead-owner adoption or public routing is authorized.
- [ ] Push and run focused plus same-SHA Contracts:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_restore_only=true -f windows_contracts_only=true
```

- [ ] Match all forty-one actual timestamped receipts, including:

```text
PASS: native restart commitment pins its exact live owner and eighth record while copied evidence ordinary authority and duplicate publication remain refused
```

- [ ] Record accepted evidence before actual committed publisher death
  and original-state snapshot/transition integration.

### Execution evidence

The test contract was pushed as `a0208843d54a5cb8676c1553aa7b932c5ea90520`.
Focused Actions run `40677325333` passed baseline job `122778961505` and
successor job `122778960721`. Restart job `122778961241` reached the fourth
explicit command and failed at `2026-10-28T11:58:27.9850493Z` because
`windows-stopped-history-handoff-restart-commit.ps1` did not exist.
The recorded phase was `restart-committed-before-proof`, after both owner
proofs and the live owner checkpoint. This is the intended missing-module
red, not a phase timeout or an aggregate job-budget cancellation.

The native implementation now retains the eighth file, descriptor, native
creator and canonical commitment time. Namespace admission invokes only the
nonrecursive retained-file assertion. Ordinary bootstrap request shapes and
the original retired lock cache remain unchanged. No state/task/runtime
authority or dead-owner adoption is added.

Accepted at `02ce98a5f6fdbc02fe1b53eafdc4088dd23b1ac5`. Focused run
`40684649023` passed baseline job `122803788347`, successor job
`122803788399`, restart job `122803788157` and aggregate job `122831080975`.
The combined three raw native logs contain all 41 workflow-required
timestamped receipts. The new receipt appeared at
`2026-10-28T13:00:52.3408632Z`. Same-SHA Contracts run `40684653615`
passed Windows job `122803801090`.
