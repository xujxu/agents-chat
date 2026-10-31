# Fresh Restart Owner Death Implementation Plan

> **For agentic workers:** Execute inline as already selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the actual fresh owner publisher and bridge, then prove a distinct actor preserves its exact owner, directory and seven records without committed authority.

**Architecture:** Add a twenty-first cumulative boundary using the accepted same-owner preparation/directory/owner protocol. Extend only the fixture's held-publication and blocked-directory proof modes; existing production refusal behavior must remain unchanged.

**Tech Stack:** PowerShell process handles, native retained file/directory proof, Node.js descriptor/byte checks, GitHub Actions only.

---

### Task 1: Hold and kill the actual owner publisher

**Files:**
- Modify: `tests/deployment-windows-history-handoff-restart-owner.ps1`
- Modify: `tests/deployment-windows-history-handoff-committed-observation.ps1`
- Modify: `tests/deployment-windows-restart-owner-publication.mjs`
- Modify: `tests/deployment-windows-restart-preparation.mjs`
- Modify: `tests/deployment-windows-restart-directory-death.ps1`
- Modify: `tests/deployment-windows-lost-runtime-session.mjs`
- Modify: `tests/deployment-windows-inactive-task.ps1`

- [ ] Add `restart-owner-dead-history`. Keep the normal twentieth boundary's
  duplicate-owner poisoning test unchanged. Held owner mode skips only that
  duplicate, retaining the actual file/directory handles and watched owner.
- [ ] Use the existing exact `create-directory` and `publish-owner`
  commands, strict before/after native proof frames and three separate
  120-second host stages. Keep 45-second per-proof/command responses and
  15-second bridge exits unchanged.
- [ ] Emit `INACTIVE_HISTORY_RESTART_OWNER_HELD` only after actual native
  owner publication and independent Node checks of its seven exact fields,
  canonical bytes, native descriptor and unchanged original evidence.
- [ ] Host validates the same actual tenth Node/bridge throughout,
  captures the exact bridge process handle, kills that Node, waits for
  both exits and checks owner plus seven record hashes and unchanged state.

### Task 2: Preserve exact dead-owner evidence without adopting it

**Files:**
- Modify: `tests/deployment-windows-successor-abandoned-observation.mjs`
- Modify: `.github/workflows/deployment-lifecycle.yml`

- [ ] Add `blockedOwner` only with restart/blocked-directory observation.
  Prove ten previous Nodes and eight publishing bridges absent; pin-check
  actual owner dev/ino/hash/bytes against the held native descriptor and
  exact seventh preparation's owner. Require one lowercase owner file.
- [ ] Require native seven-record reopen to fail specifically with:

```text
Restart prepared observation failed; retain evidence.
Committed lock directory identity differs.
```

- [ ] Require ordinary five/six-record readers and ordinary acquire/release
  refusal; owner, directory, all seven records, state and completion retain
  their exact original bytes and identities. Only fixture cleanup unlinks
  that checked owner, then the exact empty directory and seven records.
- [ ] This covers existing conservative refusal, not new production
  behavior; an initial green is valid without a missing-module red.
- [ ] Split native scheduling into baseline (history through settlement),
  successor (successor preparation through restart-preparation death), and
  restart (fresh directory through owner death). Every shard retains full
  original setup and each selected boundary's complete ancestor chain.
  Require all three actual receipt artifacts and all forty receipts.
  Do not raise the 90-minute job budget or any native/actor/exit bound.
- [ ] Push and run focused plus same-SHA Contracts:

```bash
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_application_only=true \
  -f windows_live_only=true -f windows_commands_only=true \
  -f windows_restore_scenario=failed -f windows_history_only=true
gh workflow run deployment-lifecycle.yml -R xujxu/agents-chat \
  --ref feat/deployment-backup -f windows_restore_only=true -f windows_contracts_only=true
```

- [ ] Verify all forty actual timestamped receipts, including:

```text
PASS: actual fresh restart owner publisher death preserves its exact owner directory and seven records without committed authority
```

Fresh committed capability must continue through the separately retained
normal live path, never by adopting this dead owner.

### Accepted evidence

At `0956a2283448e59e6a01496fb5892a3cde624781`, focused run
`40669641460` passed baseline job `122752862352`, successor job
`122752862226`, restart job `122752861733`, and dependent all-boundaries
acceptance job `122773727378`. Comparing all three raw native logs against
that SHA's workflow matched all forty actual timestamped receipts.
The new owner-death receipt was emitted at
`2026-10-28T10:54:19.3764964Z`. Same-SHA Windows Contracts run
`40669645851`, job `122752877791`, passed.

Actual owner/bridge death, independent conservative refusal, and exact
owner/directory/seven-record/state preservation are accepted. No
production behavior changed in this gate. Fresh committed capability
remains unimplemented and must use the normal live owner path.
