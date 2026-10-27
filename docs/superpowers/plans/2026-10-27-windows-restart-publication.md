# Fresh Restart Publication Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish exactly one immutable seventh prepared record for a fresh live owner, without lock, committed or state authority.

**Architecture:** Keep the accepted in-memory-only preparation scenario unchanged. Add a sixteenth host boundary that repeats the accepted eight-actor death chain and ninth read-only observation, then uses a distinct tenth actor for independent native publication. Its retained scope alone may extend the exact namespace from six to seven files, guarded by native pinned-file and complete typed-record binding.

**Tech Stack:** PowerShell native retained proof, bounded Node.js transport, GitHub Actions only.

---

### Task 1: Seventh-file contract

**Files:**
- Create: `tests/deployment-windows-history-handoff-restart-publication.ps1`
- Modify: `tests/deployment-windows-history-handoff-restart.ps1`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-restart-preparation.mjs`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Preserve all 34 accepted receipts and the existing preparation-only
  boundary. Add `restart-published-history` with the complete accepted
  publisher death chain, ninth observer and separate tenth publisher.
- [ ] Reuse the two-response protocol: native verified six-record ready
  frame, exact `{"type":"prepare"}` request, bounded publication response.
  Keep both 45-second response bounds, 120-second host actor and
  15-second bridge exit bounds unchanged.
- [ ] First require the explicit publication-role refusal, even when
  `HistoryHandoffRestartPreparer` is set:

```powershell
Publish-AgentsChatStoppedHistoryHandoffRestartPrepared @request
# Restart publication requires its independent native role.
```

- [ ] Enable only the separate `HistoryHandoffRestartPublisher` and publish
  through the native scalar request. Compare the entire fifteen-field
  pinned record using the shared preparation projection helper. Return only
  `{prepared,record}` where `record` is its bounded five-field projection.
  Node reads the actual descriptor-bound full file and independently
  compares all fifteen fields against the original template and fresh
  owner, never sending a potentially 1-MiB record through the 128-KiB wire.
- [ ] Repeat exact publication in the retained scope; require refusal,
  poisoned context and unchanged native file text. Prove plain six-record
  reopen and ordinary acquire/release still refuse. Compare all seven
  file bytes/identities and original state/completion; require absent lock.
  Only fixture cleanup removes the seven records.
- [ ] Push test-only and require missing
  `windows-stopped-history-handoff-restart-publication.ps1` after the actual
  tenth actor's verified bootstrap/explicit request, not timeout or an
  earlier existing-boundary failure.

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
```

### Task 2: Native create-only publisher and strict namespace

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-restart-publication.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`

- [ ] Require both fresh restart-preparer and independent publisher roles.
  Reuse `Get-AgentsChatStoppedHistoryHandoffRestartBinding` only inside a
  complete abandoned-observation bracket; do not recursively call the full
  preparation factory and duplicate its identical parent proofs.
- [ ] Fully observe the six-record ancestry before deriving native bytes,
  then create-only publish `inactive-handoff-<freshAttempt>-prepared.json`,
  retaining the native file, exact descriptor and scalar request.
- [ ] Extend the committed namespace only for this retained cache. Its
  callback must verify live publication roles, exact native descriptor and
  complete typed record against nonrecursive restart binding. Never open
  state or invoke a full getter inside that callback.
- [ ] Fully reobserve ancestry and strict seventh-record binding after
  publication. Preserve explicit failure with poisoned context and all
  evidence; same-attempt duplicates never overwrite or silently succeed.
- [ ] Require all 35 actual timestamped receipts plus same-SHA Windows
  Contracts before acceptance:

```text
PASS: native restart publication creates one exact seventh preparation while duplicate publication and ordinary authority remain refused
```

Actual publisher death and independent seven-record reopening remain the
next boundary. No native lock publication, committed capability, state
snapshot/transition or public deploy/update routing is accepted here.

## Valid missing-publisher red

Test-only `eaf3854ca2bd75a888cea397fb684288a3702d80`, run `40567938772`
/ job `122414121555`, reached the final sixteenth boundary and its verified
six-record bootstrap/explicit command, then failed at
`2026-10-27T20:13:10Z` because the native
`windows-stopped-history-handoff-restart-publication.ps1` module did not
exist. The actor exited 1 rather than timing out; the prior preparation-only
boundary remained separate and passed.

## Native implementation

The independent publisher brackets native derivation and create-only
publication with complete six-record abandoned observation. It retains
the seventh file's native handle, exact descriptor and scalar request.
Only that retained cache extends the namespace, after nonrecursive
descriptor and full typed-record binding through the existing fresh
restart binding. No ordinary reader receives an extra-name exception.
Duplicate publication poisons the context and preserves bytes; no lock,
task, runtime, committed record or state is changed.
