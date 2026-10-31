# Windows stopped-history bound admission handoff

## Scope and approval

The user approved elaborating the bound-handoff approach after native history
archival and all four actual actor-death boundaries passed. This document is
the next design review, not authorization to relax a maintenance check.

The goal is to let an exact new deploy/update owner follow a completed
stopped rollback without losing the original recovery evidence. Public
inactive routing is a later integration gate, not a consequence of publishing
an archive completion receipt.

## Alternatives

1. **Bound handoff in the existing control directory (recommended).** Reuses
   retained Windows admission and existing inactive transactions. Requires
   explicit crash-safe ownership and state-continuity proofs.
2. **A separate control generation.** Separates old and new state naturally,
   but changes control discovery, saved recovery and installed task bindings.
3. **Keep refusing subsequent operations.** Preserves current guarantees but
   does not deliver the requested repeat deploy/update lifecycle.

No option allows ignoring archived names or deleting them to clear a gate.

## Existing invariants

The archive reader proves the exact original restored state, archived intent,
entry inventory, task policy and worker/runtime settlement. The installed
disabled task still references `inactive-rollback-runtime`; that directory
must stay in place.

The existing reader requires no next-operation lock. Its permissions stay
unchanged. A distinct native handoff role must verify any prospective lock;
neither the archive writer nor completion publisher gains this authority.
JS-supplied objects are requests, never substitutes for native verification.

## Durable records and authority

Each handoff attempt has a fresh GUID and immutable, create-only records
under an operation-bound namespace. Prepared records bind:

- canonical project/control and retained control identity;
- prior operation, original state descriptor and exact state bytes;
- archived intent and completion descriptors and digests;
- exact new owner fields: token, operation, PID/start identity and creation time;
- requested command, installed task/configuration identity and stopped policy.

A prepared record grants no worker, task replacement or state-write authority.
Before preparation, pin and fully verify the original archive with the old
lock absent. Publish the new lock through a dedicated native role while the
same admission remains retained. Pin its directory and owner file, verify
their exact fields, then create a separate committed record binding their
native descriptors and the prepared-record digest. Never overwrite either
record. Ordinary lock creation cannot perform this transition.

Only a live exact owner, a committed record and a matching native recheck
jointly authorize the handoff capability. Public paths must not accept a
record alone, a copied capability or a merely matching operation GUID.

## Native preparation boundary

The native preparation role must derive the prepared record from retained
proof, rather than accept a caller-supplied prepared JSON object as evidence.
The caller supplies only the fresh attempt GUID, prospective owner token,
operation GUID, command and creation timestamp. Its PID/start identity comes
from the watched controller, not an independently supplied owner object.

Reuse `Open-AgentsChatStoppedWorkerCleanup -HistoryArchive` and its complete
`Assert-AgentsChatStoppedWorkerCleanup` checks. Require the final archived
intent and existing pinned completion receipt; preparation must not create a
missing archive completion receipt as a side effect. Derive original state
bytes and descriptor from the retained state proof, intent/completion
descriptors from their pinned handles, and task definition/security/runtime
binding from the proved native context. Resolve the installed principal SID
using the existing task principal conventions. If runtime handoff relocated
the configuration, use that proved physical bundle, not the obsolete logical
admission path.

The current completion controller reads only 4096-byte method frames.
Do not send full task definitions or state JSON through that method-only
channel, widen its parser, or add preparation authority to an archive reader.
Use a distinct preparation role with scalar owner-request inputs and an
explicit bounded prepared-record response. Before and after create-only
publication, recheck archive/task/runtime proof and actual controller identity.
An existing same-attempt record is reusable only if its derived bytes and
retained identity match; other handoff attempts remain conflicts.

Preparation alone cannot create a lock. Its first native interruption test
must kill the real preparation actor after publication, wait for the bridge
to exit, then prove a distinct actor cannot treat the durable prepared record
as committed authority. Preserve record/state bytes and identities. This
boundary must pass before implementing native lock publication.

## State continuity

Do not replace `state.json` as part of preparation or lock publication.
Preserve the original state in a separate create-only, operation-bound
snapshot and verify it against the pinned original bytes and descriptor.
This snapshot is additional evidence; it does not move or delete the original.

Before the first new phase, persist a state-transition intent binding the
committed handoff, original state digest and exact proposed first state.
That proposed state must come from existing state validation and the stopped
admission rules, not arbitrary caller-provided JSON.

The first state write requires the exact current owner and retained native
task/configuration proof. Subsequent states use existing transaction checks.
Historical verification after that write resolves the old state only through
the explicit committed transition and immutable snapshot; generic readers
must not globally substitute paths or accept the new state as old evidence.

## Interruption and cleanup

| Durable boundary | Recovery rule |
|---|---|
| No prepared record | Existing archive-only behavior |
| Prepared, no lock | No operation authority; verify original state and actor absence before sealing an abandoned attempt |
| Lock directory incomplete or owner malformed | Block and retain evidence; never infer ownership from its name |
| Exact lock published, no committed record | No workers may start; recovery must prove actor death and the prepared owner before native retirement of that exact lock |
| Committed, original state unchanged | Only the live exact owner may continue; dead-owner cleanup requires full original archive proof and exact lock retirement |
| State-transition intent, original or exact proposed state | Resolve the exact recorded transition; unrelated state blocks |
| New state/worker evidence exists | Use the new operation's verified recovery; never revert to archive-only lock cleanup |

An abandoned attempt receives an immutable terminal record. It is not reused
by a fresh actor. A fresh owner needs a new attempt and independent proof.
Uncertain settlement, changed bytes, conflicting records or identity errors
block recovery explicitly without deleting evidence.

## Lock and command integration

Keep ordinary `acquireLock`, `releaseLock` and reconciliation conservative.
Add explicit handoff-aware internal paths sharing one verifier, not three
independent filename exceptions.

Before a first state write, release requires unchanged original state,
no new worker/task evidence and the exact committed owner. After a write,
release must follow new-operation retirement and settlement. Reconciliation
reports prepared, committed or interrupted handoff status without granting
mutation authority.

Public command routing must recognize this explicit recovery status before
the current running-only discovery path. It must acquire the verified
inactive task observation and use existing inactive admission/transaction
primitives. Running-task and first-install behavior remain unchanged.
Until this routing and recovery are accepted together, public deploy/update
continues to refuse archived stopped history.

## Validation and delivery gates

All execution is in GitHub Actions. Add contracts before implementation for
record decoding, copied/foreign authority rejection and unchanged ordinary
maintenance gates. Native tests must kill real actors at each publication
and state boundary; resumers must be distinct actors and preserve evidence.

Cover changed state, lock owner replacement, live foreign owner, malformed
partial lock, duplicate attempts, tampered snapshot/receipts, disabled task
policy and worker evidence appearing during release. Assert original bytes
and native identities, not only process exit codes.

Deliver in gated increments: native prepared/committed handoff; exact-owner
release and dead-owner settlement; state continuity and recovery; public
inactive routing; actual application repeat-update/rollback; latest same-SHA
Linux/Windows regression matrix and user-facing documentation. Each increment
must preserve refusal of the not-yet-supported next increment.
