# Voice Candidate License Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce verified, bounded evidence of license materials in the two
retained Sense voice candidates, without executing or redistributing their code.

**Architecture:** A read-only Actions workflow exports the existing catalog,
runs standard-library fixture tests, retrieves exact archives and invokes a
streaming inspector. Retrieval and inspection are separate CLI commands so the
inspection step has no token. Legal uncertainty is distinct from technical failure.

**Tech Stack:** Python 3.12 standard library, dependency-free Node catalog export,
GitHub Actions on Ubuntu, existing catalog and model definitions.

---

The user chose inline execution. The named execution subskills are not available
in this session; use the explicit checkpoints below, without subagents or local
validation. Spec:
`docs/superpowers/specs/2026-09-26-voice-candidate-license-evidence-design.md`.

## Files and interfaces

- Create `scripts/voice/license_archive.py`: ZIP identity, safe member inventory,
  manifest/member verification, text selection and evidence rows.
- Create `scripts/voice/license_evidence.py`: bounded API/download handling,
  CLI orchestration, JSON/Markdown output and incomplete-run diagnostics.
- Create `tests/test_voice_license_evidence.py`: synthetic standard-library tests.
- Create `.github/workflows/voice-license-evidence.yml`: fixture and manual
  real-candidate jobs. Push runs fixture tests only.
- Update `scripts/VOICE-DEPLOYMENT.txt`: observed results, not inferred clearance.

CLI contract:

```text
python scripts/voice/license_evidence.py download CATALOG DOWNLOAD_DIRECTORY
python scripts/voice/license_evidence.py inspect CATALOG DOWNLOAD_DIRECTORY REPORT_DIRECTORY
```

Catalog export:

```javascript
import { catalogue } from './scripts/voice/download-catalog.mjs';
import { models } from './scripts/voice/setup-config.mjs';
import { writeFileSync } from 'node:fs';
writeFileSync('voice-catalog.json', JSON.stringify({ catalogue, models }));
```

## Task 1: Establish red contracts

- [ ] Write `tests/test_voice_license_evidence.py` with these public interfaces:

```python
from license_archive import inspect_archive
from license_evidence import validate_metadata, inspect_all

# Fixtures create small ZIPs with the production manifest shape and synthetic
# model/executable bytes; tests compute trusted fixture hashes independently.
# inspect_archive returns measured identities, verified file inventory and
# license_evidence rows, and only writes selected license/provenance text.
result = inspect_archive(archive, entry, model_hash, output)
assert result["technical_status"] == "verified"
assert result["distribution_clearance"] == "not-assessed"
assert not list(output.rglob("*.exe"))
```

Fixtures cover Linux and Windows, preserved license text, unknown runtime rights,
expired/wrong metadata, archive/manifest/member identity mismatches, unsafe paths,
duplicates/case collisions, symlinks, file/directory collisions, undeclared files,
text/archive/member limits, missing licenses, and partial-failure reports.
Use `unittest.subTest` for related rejected cases and `unittest.mock.patch` to
exercise size limits without allocating large buffers.

- [ ] Add workflow with `contents: read`, `actions: read`, Python3.12,
  `ubuntu-24.04`, explicit timeouts, and no dependency installation.
  Run fixture contracts with:

```bash
python -m unittest discover -s tests -p 'test_voice_license_evidence.py' -v
```

- [ ] Commit/push plan, tests and workflow. Observe the expected Actions import
  failure for the absent collector before implementing it. Do not run locally.

## Task 2: Implement archive inspection

- [ ] Implement `inspect_archive(archive, entry, model_hash, output)` with
  incremental SHA-256, `zipfile.ZipFile`, and bounded member streaming:

```python
digest = hashlib.sha256()
size = 0
while chunk := source.read(1024 * 1024):
    size += len(chunk)
    if size > maximum:
        raise ValueError("Member exceeds limit")
    digest.update(chunk)
```

Use 512 MiB archive/expanded limits, 4096 entries, 16 MiB text/member, 32 MiB
retained text total, and 1 MiB manifest limit. Check ZIP type/path collisions
before reading payloads. Compare every payload to its manifest size/hash and
reject undeclared payloads. Verify platform, model, roles, CPU flags, minimum
platform versions and Windows helper metadata. Require the catalog manifest
hash. Verify optional candidate/checksum bookkeeping instead of ignoring it.

- [ ] Retain only known license members and selected provenance excerpts.
  Preserve entire permitted license texts including miniaudio. Provenance
  excerpts include only relevant toolchain/link/source fields, not environment
  dumps; record the complete source member hash and mark excerpts as excerpts.
  Collect only after the archive has passed verification.

- [ ] Add explicit evidence rows for model Apache declaration/text, MIT engine
  notices, jsonhpp/miniaudio, GCC exception and Windows runtime review notice.
  Missing files map to `missing`; present but unidentified terms map to
  `needs-manual-review`. Runtime applicability/rights always remain manual.
  The result has no success-shaped legal-clearance field.

## Task 3: Implement retrieval and reports

- [ ] `validate_metadata(metadata, entry, now)` verifies exact artifact/run/commit,
  repository identities, bytes, digest and timezone-aware future expiry.
  Use the catalog as the only candidate list; exactly Linux/win32 Sense entries.

- [ ] `download` obtains at most64 KiB metadata via the GitHub API and records it.
  Use `urllib` with explicit HTTPS and status checks. Handle the authenticated
  archive API redirect separately; signed-object requests never carry the token.
  Bound transfer to catalog size/512 MiB, 300 seconds overall and finite per-read
  timeouts. Reject unexpected status, oversized response, missing redirect,
  truncation or wrong digest. Never log signed URLs/headers.

- [ ] `inspect_all(catalog, downloads, output)` inspects both archives and writes
  `summary.json` and `REPORT.md`. Record observed identities, reviewed commit,
  original run, file inventory, evidence rows, exclusions and incomplete stages.
  On expected IO/JSON/ZIP/value failures write diagnostics and return nonzero.
  Do not catch programmer errors into a successful report.

```python
summary = {
    "reviewed_commit": os.environ.get("GITHUB_SHA"),
    "distribution_clearance": "not-assessed",
    "candidates": [],
    "errors": [],
}
```

- [ ] Wire manual real-candidate job after fixture success: export catalog,
  download with token scoped to that step, inspect without token, always upload
  only report output with finite retention. Do not upload downloads or copy
  native/model payloads into the report.

## Task 4: Green and retained-candidate evidence

- [ ] Commit/push implementation; confirm fixture Actions run passes.
- [ ] Dispatch `voice-license-evidence.yml` on `experiment/voice-natural-long`
  using `gh workflow run ... -R xujxu/agents-chat --ref ...`.
- [ ] Inspect job logs if it fails. Fix only collector/integration problems,
  keeping catalog hashes and checks unchanged; do not mask missing notices.
- [ ] Download only the small report. Compare output to both expected candidate
  identities; read retained license/exception texts and provenance excerpts.
- [ ] Record the run ID, commit, artifact ID and concrete findings in the
  existing deployment ledger. List Windows legal evidence as unresolved if
  the report cannot establish it. Do not publish or replace a candidate.
- [ ] Commit/push evidence documentation and stop the progress reminder.

## Self-review

The tasks cover retrieval identity, streaming bounds, archive safety, complete
manifest coverage, legal-text inventory, provenance privacy, explicit unknowns,
CI-only tests, both real candidates and persistent results. No task changes
runtime behavior, resolves legal ambiguity by assumption, or expands to old
application components. Written-spec approval preceded this plan.

## Execution record

- [x] Red contracts: `4cdb05b`, Actions `36211147069`, expected missing-module failure.
- [x] Collector and retrieval/report implementation: `5bc020f`.
- [x] Ten fixture tests passed in Actions `36211292014`.
- [x] Real candidates inspected in Actions `36211314051`; both jobs passed,
  all 18 declared payload files per platform verified, no payload executed.
- [x] Report artifact `10895826318` retrieved; actual license texts and selected
  provenance read. No checklist entries missing. Linux exception text explicitly
  covers libgcc/libstdc++; Windows static-runtime authorization remains unconfirmed.
- [x] Results persisted in `scripts/VOICE-DEPLOYMENT.txt`; no candidate replacement,
  runtime change or publication. Earlier task checkboxes describe the planned
  sequence; this execution record records its completion and residual legal scope.
