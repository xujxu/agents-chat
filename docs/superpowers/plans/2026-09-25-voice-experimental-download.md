# Experimental Voice Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explicitly opt into verified candidate acquisition during Linux/Windows voice setup.

**Architecture:** A pinned catalogue authenticates metadata before a bounded gh
transfer; a separate ZIP helper extracts only verified archives into private
staging. CLI orchestration passes staging to existing importers without changing
their transactions; wrappers forward one opt-in boolean.

**Tech Stack:** Node 24, gh, yauzl, PowerShell/Bash, existing Playwright lifecycle,
GitHub Actions only.

---

The user selected inline execution. The named execution subskills are not
available in this session; execute the checkpoints here without subagents.
All commands below that download, install, build or test run in Actions.
Git/metadata inspection and editing alone run locally.

## File ownership

- `scripts/voice/download-catalog.mjs`: pinned identities and metadata validation.
- `scripts/voice/download-package.mjs`: bounded subprocess transfer and staging
  lifetime, calls `download-archive.mjs`.
- `scripts/voice/download-archive.mjs`: ZIP path/type/count/size validation and
  exclusive writes using lazy yauzl entries.
- `scripts/configure-voice.mjs`: opt-in selection and scoped importer call.
- `scripts/{deploy.sh,setup.ps1,deploy.ps1}`, shared Windows helper: flag forwarding.
- `scripts/package-release.mjs`: include the downloader's dependency closure.
- `tests/voice-download.test.mjs`: catalogue, ZIP, CLI/forwarding contracts.
- `.github/workflows/voice-download.yml`: red/green contracts and lock generation.
- `package.json`, `package-lock.json`: direct yauzl dependency.
- Existing lifecycle prepare/runner/report/workflow: explicit experimental mode,
  no prepare-time package acquisition, credentials restricted to CLI invocation.
- `scripts/VOICE-DEPLOYMENT.txt`: usage and measured evidence.

## Task 1: Red contracts and dependency closure

- [ ] Add the contract imports and metadata assertions before implementation:

```js
import { catalogue, selectDownload, validateArtifact } from '../scripts/voice/download-catalog.mjs';
import { extractArchive, validateEntry } from '../scripts/voice/download-archive.mjs';
assert.equal(selectDownload('sensevoice-small-q8', 'linux', 'x64'), catalogue.linux);
assert.throws(() => selectDownload('whisper-base-q5_1', 'linux', 'x64'));
assert.throws(() => selectDownload('sensevoice-small-q8', 'darwin', 'arm64'));
```

- [ ] Add Node tests that mutate each metadata trust field independently,
  reject expired/missing/unparseable metadata, exercise unsafe paths/type/size
  and CLI keep/disabled/offline conflict behavior.
- [ ] Add `yauzl` as a direct runtime dependency. Generate lockfile in Actions:

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
node --test tests/voice-download.test.mjs
```

  Expected red: missing catalogue/ZIP module. Upload generated lockfile even on
  test failure; retrieve that generated file without local npm execution.
- [ ] Commit red checkpoint with Copilot trailer and push feature branch.

## Task 2: Trusted catalogue and acquisition

- [ ] Implement `selectDownload(model, platform, arch)` with only the two fixed
  Sense entries from the spec; export immutable catalogue data.
- [ ] Implement `validateArtifact(metadata, entry, now = Date.now())`, returning
  validated metadata or throwing `Untrusted or expired experimental voice artifact`.
  Check all IDs, names, source repository IDs/commit, size, digest, expiry.
- [ ] Implement the gh subprocess helper with arguments as an array:

```js
['api', `repos/xujxu/agents-chat/actions/artifacts/${entry.artifact}`]
['api', `repos/xujxu/agents-chat/actions/artifacts/${entry.artifact}/zip`]
```

  Stream stdout through a byte-counting Transform into an exclusive private file;
  metadata is limited to 64 KiB/60s, archive to metadata bytes/300s. Kill only the
  owned child on timeout/overflow. Await process close and stream completion.
  Discard raw stderr; report sanitized gh installation/auth/expiry guidance.
- [ ] Add `withDownloadedPackage(entry, callback)`; allocate temporary directory,
  verify archive size/SHA, extract, verify manifest SHA, invoke callback with
  `{ packageDir, manifestSha256 }`, finally remove its own staging.
- [ ] ZIP helper: lazy yauzl open with strict file names and validated sizes;
  reject unsafe paths, case collisions, parent/file conflicts, symlink/special
  modes, encrypted files and size/count limits; stream exclusive files and check
  actual byte counts. Close reader on every exit.
- [ ] Run green download contracts in Actions; commit implementation only after
  red has been observed.

## Task 3: Wire selection and all distribution surfaces

- [ ] Add the CLI boolean and help. Inside enabling selection, use:

```js
const install = source => importer({
  ...source, model: selection.model, destination: directory,
  threads: Number(options.threads ?? models[selection.model].threads),
});
```

  With opt-in, reject local arguments and use `withDownloadedPackage` around
  install. Keep/disabled/rollback do not import downloader dependencies or call gh.
- [ ] Bash parses `--voice-experimental-download` to `--experimental-download`.
  PowerShell entrypoints accept `VoiceExperimentalDownload`, forward
  `ExperimentalDownload` to shared helper, which appends the Node flag.
  Existing upgrade re-entry preserves bound arguments.
- [ ] Package release explicitly copies yauzl's required runtime dependency
  closure (resolved from the installed dependency package, not guessed versions).
  Lazy-load ZIP helper so dependency-free keep/disabled/offline still work.
- [ ] Document experimental commands, gh login identity under sudo, expiry,
  manual offline alternative and remote microphone HTTPS.
- [ ] Actions: Node download/setup contracts (serialized), PowerShell forwarding
  tests, shell parser tests and existing release inclusion test.

## Task 4: Actual automatic acquisition lifecycle

- [ ] Add workflow input `experimental_download` (boolean, default false).
  Pass its value as `VOICE_LIFECYCLE_DOWNLOAD` only to preparation/runner/report.
- [ ] Prepare downloads source only in experimental mode. Preserve existing
  source hashes and metadata; never download model during preparation.
- [ ] Runner reads opt-in mode before filtering VOICE environment variables,
  strips GitHub tokens from server/browser/default CLI environment, and passes
  them only to the installing CLI. Install call becomes:

```js
['scripts/configure-voice.mjs', '--project-dir', process.cwd(),
 '--model', 'sensevoice-small-q8', '--experimental-download', '--non-interactive']
```

- [ ] Verify manifest in installed hash-addressed package directory and role
  hashes; persist acquisition identity/mode without tokens. Aggregate requires
  matching selected mode and catalogue for both hosts. Keep offline path intact.
- [ ] Run existing build/type/UI regressions; dispatch real workflow:

```sh
gh workflow run voice-lifecycle.yml -R xujxu/agents-chat \
  --ref experiment/voice-natural-long -f experimental_download=true
```

  Expected: 16 browser records, eight real ASR attempts, both hosts pass all
  phases; no skips/retries conceal an acquisition failure. Read Actions evidence
  for failures, push focused fixes and rerun there, never locally.

## Task 5: Durable result and B handoff

- [ ] Retrieve only small report/identity artifacts; retain run ID, measured
  commit, artifact digest/expiry and failure history in deployment ledger/spec.
- [ ] Mark checkboxes according to actual outcomes, not implementation presence.
- [ ] Commit/push results. Begin separate B design (systemd/Scheduled Task
  entrypoint new install/upgrade with no-tunnel propagation); do not label A as
  full service deployment acceptance.

## Self-review

The catalogue is not remote-configurable. Trust checks precede extraction;
manifest/importer checks still run. No tokens enter configuration or service
children. Existing default/offline behavior and paused accuracy gates are
preserved. Public release, true system services and physical devices remain
explicitly outside A.

## Execution result

- [x] Task 1: red `36106050780` at `ab5bb42`, Actions-generated lock retained.
- [x] Task 2: pinned metadata, bounded gh streams and safe ZIP staging implemented.
- [x] Task 3: CLI/all wrappers/release closure wired; contracts and existing
  platform setup regressions passed at `02d5720`.
- [x] Task 4: real automatic acquisition `36106345674` passed both hosts,
  16 records/eight ASR attempts without lifecycle retries/skips.
- [x] Task 5: result IDs/digests/expiry retained in spec and deployment ledger.

The per-step boxes above are the original execution recipe; these task-level
checks are the completion authority. Real service deployment remains B,
not an implied result of this implementation.
