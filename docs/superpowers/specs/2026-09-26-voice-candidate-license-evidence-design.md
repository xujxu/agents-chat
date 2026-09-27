# Existing voice candidate license evidence

## Goal and approved scope

Inspect the two existing SenseVoiceSmall q8 installation candidates in GitHub
Actions, without rebuilding or executing them. Establish which license and
provenance materials actually accompany their bytes. This is technical evidence,
not a legal opinion or permission to publish.

The user approved this bounded design on 2026-09-26 after narrowing the review to
components newly added for voice input. Dev Tunnels and preexisting application
dependencies are excluded. The previous whole-project inventory proposal remains
unapproved and is not a prerequisite.

## Inputs

Use the checked-in `scripts/voice/download-catalog.mjs` as the authoritative
identity of the two candidates:

| Platform | Artifact | Run | Expected name |
| --- | --- | --- | --- |
| Linux x64 | 10794617845 | 35968099304 | voice-install-sensevoice-small-q8 |
| Windows x64 | 10802394350 | 35987278609 | voice-windows-candidate-sensevoice-small-q8-86fa6716eceaf4254fb020664338fcadcce37868 |

Repository: `xujxu/agents-chat`, numeric repository ID `1260147964`.
Read archive hashes, manifest hashes, byte counts and originating commits from
the catalog; do not maintain an independently editable second trust list.
At review time both artifacts expire on 2026-10-24. Expiry or absence is a hard
error, not permission to select a newer artifact.

Whisper compatibility candidates, historical research engines and speech fixtures
are not inspected by this run. Their source-level licensing findings remain
separate, and the report must not imply their archives were checked.

## Architecture

Add a manually dispatched, read-only workflow using one GitHub-hosted Ubuntu
runner. ZIP/text inspection does not require a Windows runner. Permissions are
limited to `contents: read` and `actions: read`.

Use existing runner tools, a dependency-free Node invocation to export the
catalog as JSON, and a focused Python-standard-library inspection script.
No npm/pip installation, browser installation, compiler, server, native executable
or model inference is needed.

The collector receives the two catalog entries as data, rather than evaluating
their JavaScript in Python. Workflow selection is limited to these entries:
no user-supplied URL, repository, artifact ID or alternate source.

The GitHub token is available only to the retrieval step. Never print tokens,
authorization headers or signed download URLs. Use the explicit repository for
all GitHub operations. Do not call or change the public release workflow.

## Retrieval and archive identity

Verify artifact metadata against catalog ID, name, originating run/commit,
repository IDs, exact byte count, digest and future expiry before downloading.
The archive must then have the exact catalog size and SHA-256 digest. Metadata
alone is not byte verification.

Keep downloads on runner disk and hash/read in bounded chunks, not whole-archive
memory buffers. Use a finite transfer deadline and a 512 MiB archive limit.
Do not upload downloaded archives.

Inspect ZIP members without extracting model or executable files:

- At most 4096 entries and 512 MiB total uncompressed content.
- Reject absolute/traversal paths, backslashes, symbolic/special-file entries,
  duplicate or case-colliding paths and file/directory collisions.
- Require the expected root manifest and its catalog SHA-256.
- Stream every declared member to verify its length and SHA-256. Read to the end
  so ZIP integrity errors surface. Verify manifest platform, model and expected
  file roles; reject undeclared payload files rather than silently ignoring them.
- Permit the known manifest/checksum bookkeeping files separately from payload
  records. Check consistency of any such checksum files.

The checks run only in Actions. They do not execute the existing installer or
alter the installed application.

## License and provenance inspection

Produce a file inventory and a narrow license-evidence checklist.

For both platforms, check the actual model card's Apache-2.0 declaration,
Apache-2.0 text, FunASR/llama MIT texts, retained dependency notices and miniaudio
header/license alternatives. Report which expected file carries each declaration.
Distinguish text/declaration matching from a complete legal assessment of all
linked code.

For Linux, inspect GCC copyright, GPL/LGPL and glibc materials for the retained
runtime exception text. Report available compiler/link information and whether
the exception is present, absent or not identifiable. Presence alone does not
prove every linked runtime file qualifies for the exception.

For Windows, inspect the build record, helper compiler log, CMake cache, dependency
reports and explicit release-review notice. Report the recorded toolchain and
static-runtime settings. Do not treat system-DLL-only dependencies, a compiler
version, or a successful build as a redistribution grant.

The Windows static-runtime distribution basis remains a separate manual question.
This run does not collect a current runner's Visual Studio terms as a substitute
for the historical candidate's terms, require a new subscription, replace the
toolchain or claim that redistribution is forbidden.

## Output

Upload a small evidence artifact containing:

- `summary.json`: reviewed commit, catalog identity, measured archive/manifest
  identities, technical-check outcomes and per-platform license-evidence rows.
- A readable report distinguishing `present`, `missing` and
  `needs-manual-review`, with exact member paths and reasons.
- Relevant retained license texts and selected provenance excerpts, with source
  member hashes. Do not include model weights, executables, test audio, private
  configuration, tokens or full environment dumps.

Text collection is bounded to 16 MiB per member and 32 MiB in total; the
approximately 4 MiB miniaudio header fits. Do not truncate evidence silently.
Use deterministic output names and ordering.

The report must identify excluded candidates/scopes and always state that
technical inspection is not distribution clearance. A confirmed identity/hash
failure stops payload processing. Retain a diagnostic report where possible,
marking incomplete stages explicitly instead of fabricating empty success data.

Missing expected license material is a reported packaging gap, not an assumed
legal violation. Unresolved legal coverage remains visible even when technical
checks pass. Nothing removes the existing candidate review notice.

## Validation

Use Python standard-library tests with small synthetic ZIP fixtures in Actions.
Cover the valid two-platform report shape, catalog/manifest/member mismatches,
expired metadata, unsafe/duplicate paths, size limits, undeclared payloads,
missing license texts and unresolved runtime evidence. Confirm that missing
material cannot produce a blanket clearance and that binaries are not executed
or copied into the evidence artifact.

Develop the collector test-first. Run fixture tests before retrieving real
candidates. Then inspect both real artifacts using the same collector and review
the resulting small report. No accuracy run, full app build or browser E2E is
part of validation.

## Follow-up and non-goals

If the inspection finds missing notices, propose the precise packaging fix using
the recorded evidence. Do not mutate or silently replace the existing catalog
candidates. Producing a replacement candidate requires an explicit subsequent
implementation/qualification decision.

This design does not grant repository-owned code a new license, publish a Release,
mirror models, change package acquisition behavior or certify all components of
the application. Completion means persistent, traceable evidence for these two
archives, plus an honest list of remaining voice-only distribution obligations.
