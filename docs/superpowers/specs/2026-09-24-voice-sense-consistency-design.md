# Installed Sense cross-platform consistency diagnostics

## Status and authority

The user approved diagnosing the existing packages before controlled rebuilds
or browser-corpus work on 2026-09-24. This specification defines that bounded
diagnostic slice. Implementation waits for review of this written specification.
The parent product design remains
`2026-09-24-install-selected-voice-input-design.md`.

## Problem and confirmed evidence

Installed API runs `35990621467` and `35991326454` each delivered 100/100 samples
on both platforms. Linux Sense passes the frozen gates. Windows Server Sense
fails mixed/medium MER: 16.89%, against 14.67% baseline plus 2 percentage points.
Linux is 16.44%. This is a real qualification failure, not rounding tolerance.

The build definitions pin identical FunASR/llama.cpp revisions, weight checksum
and native thread/error patch. Both application paths generate the same model
arguments and share strict UTF-8 decoding. Linux uses GCC 12 and Windows MSVC;
the observed machines also differ. Source inspection does not establish whether
compiler, floating-point implementation, CPU, thread scheduling or another
native-path difference causes the observed transcript differences.

## Goal and non-goals

Establish whether output differences are repeatable, thread-sensitive, or
associated with the application's layers, using the already installed candidate
identities. Produce inspectable evidence and explicit limits on causal claims.

Do not rebuild engines, change weights, patch native mathematics, change default
threads, select a better configuration against the explored test corpus, alter
normalization/references/gates, or promote a candidate. This is not a new accuracy
benchmark, latency qualification, browser recorder test or Win11 acceptance.
No product behavior or production logging changes are required.

## Alternatives and choice

1. **Existing-package replay, chosen:** isolates repeatability and application
   path differences without introducing new engine builds. Cannot alone separate
   compiler from OS or CPU effects.
2. **Controlled native rebuilds:** useful after a specific hypothesis emerges,
   but introduces new binaries and broader qualification obligations immediately.
3. **Browser-chain acceptance first:** independently useful but adds capture and
   resampling variables and does not explain the current original-WAV API result.

## Fixed inputs

Reuse the trusted source artifacts already used by installed API acceptance:

| Input | Run | Artifact |
| --- | --- | --- |
| Linux Sense package | `35968099304` | `10794617845` |
| Windows Sense package | `35987278609` | `10802394350` |
| ASCEND corpus | `35858271102` | `10748244312` |
| AISHELL-4 corpus | `35863991538` | `10752270787` |
| Prior Linux API evidence | `35991326454` | `10804222694` |
| Prior Windows API evidence | `35991326454` | `10803903893` |

Use the existing frozen100 preparation, then select exactly 12 unique samples:
all eight `mixed` samples with `5 < duration < 15`, plus one each from
`zh/short`, `en/short`, `zh/long`, `mixed/long`. Choose each control by ascending
SHA256 of UTF-8 `sense-consistency-v1:` followed by sample ID; break ties by ID.
Short is <=5 seconds; long is >=15 seconds. Fail on absent strata, an unexpected
mixed/medium count, duplicate IDs or mismatching original waveform hashes.

Selection does not inspect recognized text or error rates. The eight failing
stratum samples are intentionally diagnostic, not an unbiased holdout.
Write the selected manifest before any inference. Do not send references,
hotwords or forced-language settings to any inference path.

## Experiment matrix and ownership

Use one Ubuntu 24.04 job and one Windows Server 2022 job. Within each job,
keep the same downloaded package, host and waveform bytes for every comparison.
Each job runs threads in fixed order 2, 1, 4. For each thread count, run three
repetitions of all 12 samples across all three surfaces below: 324 attempts per
platform, 648 overall. All attempts are sequential and use a fresh native process.

The actual configurator imports and persists the selected package and thread
count. Restart the isolated application after each thread change; assert the
authenticated capability matches Sense, standard policy and requested threads.
Standalone diagnostic children load the same persisted configuration rather than
inventing binary/model paths. Clear inherited voice overrides before configuration.
No concurrency, new CPU/RAM quota, or service installation is introduced.

For each repetition, visit sample IDs in stable sorted order and run these
surfaces in order:

1. **Supervised native stdout:** use existing `runVoiceProcess` with the
   installed configuration and a private temporary WAV. Preserve successful
   stdout bytes as base64 plus SHA256, and decode with `decodeVoiceText`.
   Reuse Windows private-directory creation and existing Job supervision;
   do not bypass process-tree cleanup or create a second native launcher.
2. **Application transcriber:** call `transcribeVoice` with the identical bytes
   and installed configuration. This is a separate native invocation.
3. **Authenticated API:** use the existing login fixture and real unmocked
   `/api/voice`, uploading those same original WAV bytes. No browser capture.

The native surface still shares the production process supervisor and decoder.
It is not an independent implementation of the engine. Separate invocations
mean a mismatch cannot by itself prove corruption in an application layer.
Fixed order and filesystem caching also prevent unbiased latency comparisons.

## Components and evidence contracts

Keep diagnostic-only responsibilities outside product runtime:

- A small deterministic selection/report module and its Python contracts own
  sample selection, exact matrix completeness and paired output comparisons.
- A TypeScript native/transcriber collector owns installed configuration,
  private input lifetime, supervised calls and incremental attempt records.
- A Playwright diagnostic collector owns authentication, capability assertions
  and original-WAV API requests. It does not extend normal user-facing UI.
- A Node orchestrator owns configurator execution, per-thread app lifetime,
  collector sequencing and allowlisted host/package provenance.
- A dedicated Actions workflow downloads pinned artifacts, builds the app,
  runs contracts and collectors, aggregates both platforms and retains reports.

An attempt is uniquely keyed by platform, sample ID, threads, repetition and
surface. Record waveform hash, installed manifest/binary/model/helper hashes
(helper absent on Linux), model identity, failure or text, attempt elapsed time
and applicable HTTP status/API processing time. Native successful rows also
retain bounded stdout bytes/hash. Do not represent unavailable measurements
as zero. Record commit/run, OS, CPU model, logical CPU count and observed memory;
effective external quotas, physical cores and native peak RSS remain unknown.

Incrementally write attempts. Completion requires all 324 unique tuples per
platform. Reject missing/duplicate/unexpected tuples, changed sample/package
identity, invalid types, nonfinite/negative timings and malformed responses.
Compare prior default-thread API evidence only after matching input and package
identities; describe host changes instead of treating historical timing as paired.

## Reporting and interpretation

The aggregate report separates:

- Within-surface repeatability for each sample/thread/platform.
- Native decoded text versus transcriber/API exact text within the same host.
- Thread sensitivity within the same platform/surface.
- Linux versus Windows exact output differences at matching settings.
- Current default-thread API outputs versus the retained prior API evidence.

Report every failure, including empty transcripts. Comparisons with failed
attempts are explicitly unavailable, not equal nulls or silently dropped rows.
Preserve text examples in the diagnostic artifact, not console or server logs.
No recomputed error-rate winner or recommended thread count is produced.

Stable cross-platform differences at all surfaces support a difference below
HTTP/text composition, but do not identify a compiler or CPU cause. Unstable
same-host repeats prevent attributing a one-off layer mismatch to that layer.
Agreement on this subset cannot qualify the full corpus or prove determinism.

Completion/report integrity and successful delivery are checked independently
from output equality. Observed text mismatches are diagnostic findings, not an
infrastructure failure. Any failed delivery makes the diagnostic delivery check
fail after reports are retained. Incomplete evidence fails explicitly and is
never reported as a complete experiment.

## Error handling, privacy and cleanup

Reuse the 120-second process deadline, 32 KiB stdout bound, existing process
groups/Windows Job lifecycle and private request directories. API calls have
the existing 130-second client bound. Recognized inference/timeout/transport
failures remain failed attempts; invalid identity/auth/configuration or malformed
responses abort with explicit infrastructure failure. Every owned app process
is stopped and awaited in `finally`; request directory cleanup is checked.

Upload only allowlisted manifests, attempt records, reports and sanitized host
provenance, with 30-day retention. Never upload environment files, receipts,
cookies, browser storage state, credentials, whole workspaces or model weights.
Do not alter normal service logging to expose native output or transcripts.
The diagnostic corpus evidence is not a permanent distribution channel.

## Verification and exit criteria

TDD contracts cover deterministic selection, the exact matrix, duplicate and
missing attempts, identity mismatch, invalid timing, failed/empty outputs,
repeat instability and stable cross-platform differences. Build/typecheck,
collector execution and all inference run only in GitHub Actions.

This slice ends when both platform reports and the aggregate are persisted with
exact run/commit/artifact identities and a bounded conclusion: repeatable native
difference, observed instability, suspected layer-associated difference, or
insufficient evidence. Do not claim a root cause without a controlled comparison.
Choose any subsequent rebuild experiment separately based on those findings.

PROD, cpg's existing 1.5 GiB limit and the old sampler remain untouched. Actual
Win11, browser-corpus and redistribution/download gates remain open.
