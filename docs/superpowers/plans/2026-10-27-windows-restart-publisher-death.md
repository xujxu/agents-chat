# Fresh Restart Publisher Death Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the real fresh restart publisher and bridge, then prove a distinct eleventh native actor can observe all seven records without continuation authority.

**Architecture:** Preserve accepted preparation-only and normal seventh-file publication boundaries. Add a seventeenth host boundary repeating the accepted original/successor death chain and ninth observer, holding the real tenth restart publisher after publication, and killing that exact controller before an independent eleventh observer reopens seven records.

**Tech Stack:** PowerShell native retained observation, bounded Node.js transport, actual Windows process handles, GitHub Actions only.

---

### Task 1: Actual death contract

**Files:**
- Create: `tests/deployment-windows-history-handoff-restart-observation.ps1`
- Modify: `tests/deployment-windows-history-handoff-restart-publication.ps1`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-restart-preparation.mjs`
- Modify: `tests/deployment-windows-successor-abandoned-observation.mjs`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Keep all 35 prior receipts and normal publication duplicate-refusal
  coverage. Held publication skips only that poison-producing duplicate
  call; it derives and binds the same actual full record.
- [ ] Capture two bounded native frames, validate actual bridge identity,
  read descriptor-bound seventh bytes, and emit the actual held metadata:

```text
INACTIVE_HISTORY_RESTART_PREPARED_HELD <seven-descriptor metadata>
```

- [ ] Host captures the exact publishing bridge process handle before
  killing the tenth Node controller. Wait at most 15 seconds for each
  process exit; compare seven evidence hashes, absent lock and original
  state before starting the eleventh actor. Keep per-frame 45-second,
  per-host-actor 120-second and bridge 15-second bounds unchanged.
- [ ] Eleventh actor proves ten prior Node identities and eight publishing
  bridge identities absent, seven file bytes/hash/dev/ino exact, original
  state/completion bytes and identities unchanged. Reuse the existing
  read-only positive/negative proof with an explicit restart mode.
- [ ] New fixture receives only an eight-field descriptor request, parses
  it with the existing strict native parser, then loads the missing module.
  Its native observer call is:

```powershell
Open-AgentsChatStoppedHistoryHandoffRestartObservation $Control $ControllerPid $ControllerIdentity `
  $inputRecord.attemptId $inputRecord.prepared $inputRecord.committed $inputRecord.retirement `
  $inputRecord.terminal $inputRecord.successor $inputRecord.successorAbandoned $inputRecord.restart
```

- [ ] Require wrong seventh inode, same-byte replacement, foreign lock,
  ordinary five/six-record reopen, ordinary acquire/release and read-only
  preparation/publication mutation to refuse while retaining evidence.
  Only fixture cleanup removes seven records and restores the fixture.
- [ ] Push test-only and require the actual eleventh native entry to fail
  for missing `windows-stopped-history-handoff-restart-observation.ps1`
  after real publisher death, not an earlier failure or timeout:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
```

### Task 2: Explicit seven-record read-only observation

**Files:**
- Create: `scripts/deployment/windows-stopped-history-handoff-restart-observation.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-restart.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-restart-publication.ps1`
- Modify: `scripts/deployment/windows-stopped-history-handoff-committed-observation.ps1`

- [ ] Extend the strict committed request with optional tenth `restart`
  field only when all six ancestor descriptors are explicit. Validate its
  canonical fresh attempt filename and 1-MiB descriptor, include exactly
  seven names before native opens and initialize its cache after the
  existing six-record abandoned bootstrap.
- [ ] Pure restart binding accepts live preparer XOR independent dead-owner
  observer, never mixed. Live preparer still requires the exact watched
  controller. Observer derives owner scalars only from the actual pinned
  record and requires native absence; public factory remains preparer-only.
- [ ] Strict seventh binding accepts live publisher/preparer XOR read-only
  observer, preserving complete typed JSON and descriptor proof.
- [ ] Open the explicit seven-record committed scope without mutating any
  file. The bounded getter brackets one complete ancestor observation
  with seventh-record assertions and returns:

```text
{status:'restart-prepared-observed',attemptId,previousAttemptId,
 previousOperationId,project,prepared,predecessor,
 runtimeAuthority:false,lockAuthority:false}
```

- [ ] Keep ordinary openers unchanged and conservative; copied records,
  uncertain identity and namespace conflicts preserve evidence and fail.
  Require all 36 actual timestamped receipts plus same-SHA Contracts:

```text
PASS: actual fresh restart publisher death preserves seven exact records for a distinct eleventh native observer without continuation authority
```

No dead preparation is reused. Keep the separately accepted normal live
publisher path available for the later native lock-publication gate rather
than creating another fixed successor generation to proceed.

## Fixture bootstrap correction before valid red

Test-only `3c11d2420edaaa24e9d4f6e3ffa449eca0779bea`, run `40583531474`
/ job `122468937243`, reached the actual eleventh actor after real restart
publisher/bridge death, but failed at `2026-10-27T21:51:39Z` because the
standalone fixture had not loaded the existing stopped-worker cleanup
dependency root and therefore lacked `Read-AgentsChatRetirementJson`.
This is not valid missing-observer red. Load the same cleanup root as the
accepted committed-observation fixture before strict request parsing; keep
the native observer module absent and rerun the test-only gate.

## Valid missing-observer red and implementation

Corrected test-only `e50685973da6d1454af79464af0e7d547c54f7cc`, run
`40590433344` / job `122492960129`, retained the separate normal seventh-file
publication receipt at `2026-10-27T22:36:14.9128671Z`, then completed actual
restart publisher/bridge death and reached the eleventh native actor.
At `2026-10-27T22:42:02.9856985Z` it failed for the missing native
`windows-stopped-history-handoff-restart-observation.ps1`, not timeout or
fixture bootstrap.

The implementation adds only explicit optional tenth `restart` request
field, seven-name bootstrap, and independent dead-owner observer. Native
binding accepts live preparer/publisher XOR read-only observer; public
factories remain live-role-only. The readonly getter brackets complete
ancestor observation with strict seventh-file assertions and returns nine
bounded fields with both authority flags false. Ordinary five/six-record
readers retain their original namespace refusal.

## Aggregate job budget correction

Implementation `ab1eb23dfa35d629f0ee48bf3d18c0e89ddbe121` passed Windows
Contracts in run `40597324559` / job `122516431880`. Focused run
`40597320749` / job `122516424987` was cancelled at
`2026-10-27T23:46:28.2253598Z` by the entire job's 60-minute limit,
not an individual native request/actor failure. Its seventeen cumulative
boundaries reached the final chain before cancellation.

Allow 90 minutes for the aggregate job with all seventeen boundaries;
retain every assertion and the unchanged 45-second per-response,
120-second per-actor and 15-second bridge-exit limits. This cancellation
is not acceptance; rerun focused and Contracts together on the new SHA.
