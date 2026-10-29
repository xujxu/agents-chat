# Windows Restart State Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the ninth record (`inactive-handoff-<attempt>-state-intent.json`) is retained, the same native restart publisher writes exactly its `nextState` into `state.json` through an acknowledged `state.json.lock` stage, without gaining runtime, task, lock, or release authority.

**Architecture:** Reuse the stopped rollback state publication shape from `scripts/deployment/windows-inactive-rollback-state.ps1`: create-only stage `state.json.lock` with the exact intent `nextState`, prove it, re-run every ancestor observation while the original `state.json` inode is still the one described by the original prepared template, release only handles on the staged and original state inodes, call `[Deployment.WindowsPrivateFile]::PublishSourceFile`, then reopen `state.json` and require the staged inode and the `nextState` hash. Ancestor getters are not changed: because `Open-AgentsChatRetirementFile` pins the original state descriptor, every ancestor observation must finish before the rename and none may run afterwards in the same publisher.

**Tech Stack:** PowerShell 7 native modules, `Deployment.WindowsPrivateFile`, Node fixtures under `tests/`, GitHub Actions (`deployment-lifecycle.yml`, stopped-history `commitment` shard). All validation runs only in GitHub Actions.

---

### Task 1: Test contract (red)

**Files:**
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1` (new `-WriteRestartState`, requires `-PrepareRestartState`)
- Modify: `tests/deployment-windows-history-handoff-restart-state-intent.ps1` (add `-Continue`)
- Create: `tests/deployment-windows-history-handoff-restart-state-write.ps1`
- Modify: `tests/deployment-windows-restart-publication-progress.ps1/.mjs` (`state-stage` and `state-write` publications)
- Create: `tests/deployment-windows-restart-state-write-publication.mjs`
- Modify: `tests/deployment-windows-restart-preparation.mjs`, `tests/deployment-windows-lost-runtime-session.mjs`, `tests/deployment-windows-inactive-task.ps1`
- Create: `tests/deployment-windows-restart-state-write-controller.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml` (new required receipt)

- [x] Role refusal `Restart state write requires its independent native role.`
- [x] Role refusal leaves no `state.json.lock`.
- [x] Successful write: `state.json` text equals intent `nextState`, inode equals acknowledged stage inode, `nlink=1`, no `state.json.lock` or `state.json.lock.pending-*` remains, nine records unchanged.
- [x] Duplicate refusal `Restart state write failed; retain evidence.` poisons the context.
- [x] Result `{status:'restart-state-written', attemptId, stateIntent, state:{path:'state.json',dev,ino,bytes,sha256}, runtimeAuthority:false, lockAuthority:false, taskAuthority:false}`.
- [x] Boundary `restart-state-written-history` joins the `commitment` shard; the Node fixture restores the original state bytes in place after asserting the written inode so later boundary hash checks are unchanged.
- [x] Actions red: focused run `40814409746` passed baseline `123253770727`, successor `123253770896` and restart `123253770926`; commitment job `123253770883` re-passed gate 43 at `04:30:44Z`, delivered the exact write command and failed at `2026-10-29T04:39:16Z` in `restart-state-write-before-proof` because `windows-stopped-history-handoff-restart-state-write.ps1` did not exist.

### Task 2: Production module (green)

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-restart-state-write.ps1`

- [x] Stage, ancestor observation, release, `PublishSourceFile`, reopen and inode check, mirroring `Publish-AgentsChatInactiveRollbackState`.
- [x] Any failure poisons and throws `Restart state write failed; retain evidence.`
- [x] Stage admission fix `ea0c6a51`: the retained `state.json.lock` stage is admitted by inventory only after its own `.Check()` while the writer re-observes ancestors.
- [x] Native write receipt: run `40831077522` commitment job `123305455678` printed the gate receipt at `2026-10-29T07:44:52Z`.
- [x] Boundary flow fix `614e3c11`: written/dead state boundaries end at their transition proof, because generic identity-pinned archive readers correctly refuse once the original inode is replaced.
- [ ] Actions green and all required receipts present across the four shards; Contracts green.
