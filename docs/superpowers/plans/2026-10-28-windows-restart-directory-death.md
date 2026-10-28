# Fresh Restart Directory Death Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the real live restart directory publisher and bridge, then prove a distinct actor preserves its exact incomplete directory and seven records without adopting or deleting them.

**Architecture:** Keep all eighteen accepted boundaries and native production behavior unchanged. The nineteenth boundary holds the actual native empty directory in the same live publication scope, kills the tenth controller and exact bridge, and has an eleventh actor prove conservative native/ordinary refusal with unchanged original state.

**Tech Stack:** PowerShell host process handles, native retained directory proof, bounded Node.js transport, GitHub Actions only.

---

### Task 1: Hold and kill the actual directory publisher

**Files:**
- Create: `tests/deployment-windows-restart-directory-death.ps1`
- Modify: `tests/deployment-windows-history-handoff-restart-lock.ps1`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-restart-preparation.mjs`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`

- [ ] Preserve normal directory duplicate refusal. Held mode skips only
  the poison-producing duplicate and keeps the actual native directory
  handle, seven pinned records and original watched owner alive.
- [ ] Reuse the acknowledged live publication/directory protocol; emit
  `INACTIVE_HISTORY_RESTART_DIRECTORY_HELD` only after actual native
  creation, exact directory identity/empty-inventory checks, seven file
  byte/identity checks and unchanged state/completion.
- [ ] New focused host helper reads the live checkpoint, validates actual
  Node/bridge identity and preparation digest, then sends only:

```text
{"type":"create-directory"}
```

- [ ] Read the held-directory checkpoint within its separate 120-second
  stage. Capture the exact native bridge process handle before killing the
  actual tenth Node. Wait at most 15 seconds for each exit. Check seven
  evidence hashes, preserved empty directory and original state hash.
  Keep native response/command bounds at 45 seconds.

### Task 2: Explicitly blocked independent takeover

**Files:**
- Modify: `tests/deployment-windows-successor-abandoned-observation.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Reuse the existing seven-record proof with explicit
  `blockedDirectory` mode; it is valid only with restart observation.
  Prove ten prior Nodes and eight publishing bridges absent and all
  seven file hashes/dev/ino plus original state/completion unchanged.
- [ ] Require native seven-record reopen to fail specifically at:

```text
Restart prepared observation failed; retain evidence.
Committed lock directory identity differs.
```

The original committed initializer cannot adopt a newly created directory
as its retired predecessor. A dead prepared owner or filename is not a
directory-retirement capability. This is coverage for existing required
conservative behavior, not a new permitted production mutation; an initial
green result does not imply a missing red implementation step.

- [ ] Require ordinary five/six-record readers and ordinary acquire/release
  to refuse. Compare actual residual directory dev/ino and empty inventory
  both before and after refused operations, preserving all evidence until
  fixture-only identity-checked empty-directory/seven-record cleanup.
- [ ] Retain every prior positive/tamper scenario outside blocked mode;
  do not treat a refusal caused by an existing directory as tamper coverage.
- [ ] Push and run focused plus Contracts on the same SHA:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_restore_only=true -f windows_contracts_only=true
```

- [ ] Require all 38 actual timestamped receipts, including:

```text
PASS: actual fresh restart directory publisher death preserves the exact incomplete directory and seven records without continuation authority
```

After acceptance, continue owner publication only through the separately
retained normal live directory path. Do not recover/reuse the dead owner or
infer ownership of its incomplete directory.

### Validation investigation

- At `d9b04e11fdbc2590a2a953f2518e2373f7da3c77`, Contracts run
  `40623195074` passed. Focused run `40623191848`, job `122601866132`,
  failed at `2026-10-28T04:01:48.3028626Z` in the preceding normal
  eighteenth directory scenario, before the new death boundary.
- The cause was `Native worker transport timed out.` with empty native
  stderr, not the aggregate job limit. The previous ninth-observer receipt
  was emitted at `2026-10-28T03:59:53.6680837Z`. The old error did not
  distinguish bootstrap, publication, host command, directory publication
  or exit, so the exact failing receive is not yet established.
- Add timestamped fixture phase history to the existing failure, retaining
  all native proofs, protocol messages and 45/120/15-second bounds. Repeat
  focused and Contracts on the same diagnostic SHA before attributing the
  failure to directory proof cost or changing production behavior.
- The nineteenth boundary remains unaccepted until all 38 actual receipts
  and same-SHA Contracts pass.

### Accepted evidence

At `8a607553a0fcc2272cad04d71d52f553f13bb3b3`, focused run
`40630365919`, job `122625073599`, passed. All 38 required receipts were
matched against actual timestamped log output, including the nineteenth
boundary at `2026-10-28T05:04:04.3062491Z`. Same-SHA Windows Contracts run
`40630368605`, job `122625082456`, passed.

The normal eighteenth directory receipt also passed at
`2026-10-28T04:57:51.5716149Z`. No production behavior or timeout changed.
This successful rerun does not establish the earlier timeout's exact
stage or root cause; retain the new phase diagnostics for any recurrence.
Actual publisher death and conservative residual-directory preservation
are accepted. Owner publication and subsequent continuation authority
remain separate, unimplemented boundaries.
