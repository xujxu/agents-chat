# Fresh Restart Lock Directory Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish only an exact native pinned empty lock directory for the separately accepted live restart owner, retaining all seven historical records and unchanged original state.

**Architecture:** Keep all seventeen accepted boundaries. An eighteenth boundary uses the normal live publisher, not the dead-owner observer, and retains its exact Node owner/native bridge through an explicit host-controlled directory command. Historical retired-lock proof remains separate from the new physical directory and only an independent restart-lock publisher may bind the latter.

**Tech Stack:** PowerShell native retained directory/file proof, bounded Node.js transport, explicit host acknowledgement, GitHub Actions only.

---

### Task 1: New directory contract

**Files:**
- Create: `tests/deployment-windows-history-handoff-restart-lock.ps1`
- Modify: `tests/deployment-windows-history-handoff-restart-publication.ps1`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-restart-preparation.mjs`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Preserve every preparation-only, normal duplicate-refusal and real
  publisher-death assertion. Add `restart-directory-history`, repeating
  the accepted six-record ancestry and ninth observer before the tenth
  live publisher derives and publishes a fresh seventh record.
- [ ] New directory mode skips only the existing duplicate publication
  that would intentionally poison its retained scope. Publish a bounded
  native `restart-published` frame and retain the same live bridge.
- [ ] Node validates the full actual seventh file and exact live owner,
  emits `INACTIVE_HISTORY_RESTART_PREPARED_LIVE`, then accepts only
  `{"type":"create-directory"}` from the host. Host checks actual Node PID,
  native bridge identity, prepared digest and absent lock before sending
  that command. Forward the same exact command to the retained bridge.
- [ ] Bound each native response and host command by 45 seconds. The
  new live transaction has two separately acknowledged host stages,
  publication and directory creation, each bounded by 120 seconds.
  Keep all seventeen earlier actor budgets unchanged and bridge exit
  bounded by 15 seconds. Do not combine additional full proofs into an
  old single-response budget or drop proof to fit.
- [ ] Load the deliberately missing native module only after both live
  publication acknowledgements and the explicit directory command.
  Native test invokes:

```powershell
New-AgentsChatStoppedHistoryHandoffRestartLockDirectory $Context $ControllerPid $ControllerIdentity
# Without independent role:
# Restart lock publication requires its independent native role.
```

- [ ] Set only `HistoryHandoffRestartLockPublisher`, publish and check its
  actual retained directory identity. Duplicate creation must refuse,
  poison and preserve the exact empty directory. Return only:

```text
{status:'restart-lock-directory',attemptId,prepared,directory:{dev,ino},
 runtimeAuthority:false,lockAuthority:false}
```

- [ ] Node proves all seven evidence bytes/hash/dev/ino and original
  state/completion unchanged, ordinary readers/acquire/release refused,
  and only the exact empty directory exists: no owner, committed record,
  new worker or state. Close native handles, then fixture-only identity
  checks permit empty-directory removal and seven-record cleanup.
- [ ] Push test-only and require missing native
  `windows-stopped-history-handoff-restart-lock.ps1` after the explicit
  directory command, not an earlier error or timeout:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
```

### Task 2: Exact native directory publication

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-restart-lock.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-lock.ps1`

- [ ] Require independent restart-lock publisher, existing live
  restart-preparer/publisher, exact watched controller and actual pinned
  seventh record. Never accept a dead-owner observer or caller owner JSON.
- [ ] Fully observe the settled ancestry and strict seventh record before
  create-only native directory creation. Preserve old `HistoryHandoffLock`
  and all retired original owner/directory metadata; retain the new
  directory and native identity under `HistoryHandoffRestartLock`.
- [ ] In the original retired-directory assertion, keep physical absence
  mandatory unless this explicit live role and actual retained new
  directory cache exist. Delegate only to a nonrecursive checker that
  validates current native owner, pinned seventh record, actual directory
  handle/identity, exact lowercase root name and empty child inventory.
  A role flag alone, matching filename or unpinned directory is insufficient.
- [ ] Bracket creation with full ancestor proof; strict new-directory
  assertions after publication cannot invoke a full parent getter from
  inside the old lock callback. Any failure poisons the context and retains
  evidence. Existing ordinary readers remain unchanged.
- [ ] Require same-SHA focused all 37 actual timestamped receipts plus
  Windows Contracts before acceptance:

```text
PASS: native restart lock directory publication pins only its exact fresh live preparation without owner committed or state authority
```

Owner publication, committed capability, immutable state snapshot, first
transition, handoff-aware release and public routing remain later gates.
An incomplete directory never authorizes inference or ordinary cleanup.

## Valid missing-directory-module red

Test-only `f4f8b3d3e24aab2be0e1cd197d86a7fc805a02d7`, focused run
`40610565724` / job `122560821941`, retained the separate eleventh-observer
receipt at `2026-10-28T01:35:19.1894413Z`, then completed the eighteenth
boundary's live seventh-file publication and explicit host/native directory
command. At `2026-10-28T01:41:15.0762634Z` it failed for the missing native
`windows-stopped-history-handoff-restart-lock.ps1`, not timeout or an
earlier proof failure.

## Native implementation

Directory creation requires the independent role, strict actual live
seventh-record publication and exact watched controller. Full ancestor
observation brackets create-only native directory publication. A separate
retained directory handle/identity leaves the original retired lock cache
unchanged. The original retired-directory assertion permits a physical
directory only through this explicit role plus the strict nonrecursive
native handle/identity, live preparation and empty-inventory checker;
flags or names alone remain insufficient. Failures poison and retain.
No owner, committed record, task/runtime or state write is published.
