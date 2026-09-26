# Windows Voice Package Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify and stage exact Windows model packages, including their lifecycle helper, with truthful CPU/memory guidance before configuration activation.

**Architecture:** Extend shared manifest validation with a distinct Windows version, preserving Linux version 1. A focused Windows importer hashes every staged file before running the trusted helper's baseline-CPU host probe. Keep the existing configuration CLI's Windows enablement gate until private configuration/receipt and deployment integration are implemented.

**Tech Stack:** Dependency-free Node ESM, Win32/MSVC helper, node:test/tsx, existing Actions native candidate matrix.

---

## Scope and authorization

User approved the parent design and inline execution. Real Windows candidates
`37f6612` passed Actions `35977946646`; evidence checkpoint is `c2d69cf`.
Do not repeat model selection or build a separate decoder.

This is the import prerequisite of the installer, not full Windows setup.
The importer returns checked paths; it never writes `.env.local`, starts a
service, modifies Scheduled Tasks or creates secret-bearing receipts.
`configure-voice.mjs` continues to reject Windows enablement until its atomic
configuration and receipt ACL work is complete. No false supported menu.

All execution/validation is Actions-only. No PROD/cpg/sampler changes, permanent
downloads or public release. Helper redistribution permission, actual Win11 and
full-corpus acceptance remain open gates.

## File map

| Path | Responsibility |
| --- | --- |
| `scripts/voice/package-schema.mjs` | Extract shared validator; add exact Windows version 2/platform/helper/path contracts |
| `scripts/voice/install-package.mjs` | Re-export validator for existing consumers; preserve Linux import |
| `scripts/voice/windows/import-package.mjs` | Windows-only verified staging, host guidance and idempotence; no config writes |
| `scripts/voice/windows/voice-host.h` | Native baseline CPU/OS-state and memory observation, not resource enforcement |
| `scripts/voice/windows/voice-job.cpp` | Dispatch `--inspect-host` |
| `scripts/voice/package-manifest.mjs` | Generate explicit `windows-x64` manifests alongside existing Linux mode |
| `scripts/voice/windows/build-candidate.ps1` | Generate version 2 CI import manifest after existing candidate inventory |
| `tests/voice-setup-windows.test.mjs` | Pure cross-platform schema/host-observation negative tests, run on Linux |
| `tests/voice-windows-import.test.ts` | Actual import, corruption, idempotence and installed real transcription in Windows Actions |
| `.github/workflows/voice-windows-packages.yml` | Run imported-package smoke after real candidate smoke |

## Task 1: Red schema and resource contracts

- [x] Add schema tests defining Windows identity:

```js
const windows = {
  version: 2, platform: 'windows-x64', minWindowsBuild: 19041,
  helperProtocol: 2, utf8Paths: true,
  qualification: 'integration-candidate-not-release-approved',
  modelId: 'sensevoice-small-q8',
  cpuFlags: ['avx2', 'fma', 'f16c', 'bmi2'],
  files: [
    { path: 'bin/engine.exe', role: 'binary', sha256: 'a'.repeat(64), bytes: 10 },
    { path: 'bin/voice-job.exe', role: 'helper', sha256: 'b'.repeat(64), bytes: 10 },
    { path: 'models/model', role: 'model', sha256: models['sensevoice-small-q8'].modelSha256, bytes: 100 },
    { path: 'licenses/notice.txt', role: 'license', sha256: 'c'.repeat(64), bytes: 10 },
  ],
};
assert.equal(validateManifest(windows, windows.modelId).helper, 'bin/voice-job.exe');
```

  Reject helper missing/duplicated, Linux helper roles, wrong OS version/schema,
  case-insensitive collisions, file/directory collisions, device names such as
  `CON.txt`, trailing dots, empty/dot/traversal components, ADS, UNC/drive paths,
  wrong weights, oversize inventories and unqualified helper protocol.
  Keep every existing Linux contract unchanged.

- [x] Test `validateWindowsHost(info, manifest)` as a pure boundary. Reject a
  missing CPU flag, OS build below declared minimum, nonfinite/negative memory,
  absent OS-state-supported AVX, inconsistent counts and malformed observations.
  Unknown enclosing Job quotas remain unknown, not unlimited.

- [x] Commit tests, push and inspect the existing `voice-setup.yml` contracts.
  Expected red: Windows schema unsupported / missing helper module. Do not
  accept a runner infrastructure failure as evidence of the intended test.

## Task 2: Exact manifest and conservative import

- [x] Extract existing schema into `package-schema.mjs`, keep re-export from
  `install-package.mjs`. Add one helper role only for Windows version 2 and
  require `.exe` for binary/helper. Minimum build 19041 is an implementation
  compatibility floor for UTF-8 paths, not a Win11 qualification claim.
  Validate Windows names case-insensitively and detect parent-file collisions.

- [x] Export the Windows importer and host validator:

```js
export function validateWindowsHost(info, manifest);
export async function importWindowsVoicePackage({
  packageDir, manifestSha256, model, destination, threads, log = console.log,
});
```

  Require win32/x64 and threads 1/2/4. Require external trusted manifest SHA256.
  Bound manifest read to 256 KiB before parsing. All package files must be
  ordinary single-link files inside the source, with no symlink/junction path
  components. Reject a linked manifest/source root too.
  Check total size and staging disk, then copy declared files only.
  Recheck every staged file's byte count/SHA256 **before** executing the helper.
  Never execute a helper directly from unchecked downloaded files.

- [x] After all copied bytes match, run checked helper with `--inspect-host`:

```js
const { stdout } = await execFileAsync(helper, ['--inspect-host'], {
  windowsHide: true, timeout: 10000, maxBuffer: 16384, encoding: 'utf8',
  env: sanitizedWindowsEnvironment,
});
```

  Environment includes only required Windows system paths and temporary paths;
  no inherited application secrets. Helper failure is a surfaced install error,
  not a fallback observation. Reject required CPU/OS incompatibility.
  Log available physical memory, processor count/current-group affinity and
  enclosing Job presence, explicitly distinguishing them from target-service
  reservations/quotas. Low memory is guidance, not an invented measured minimum.

- [x] Rename completed staging into `packages/<manifestSHA>`. If already present,
  verify its manifest and all declared files before returning it; tampering
  fails rather than overwriting. Handle only known rename collisions and
  preserve errors such as access denial. Always remove this invocation's stage.
  Return `{ binary, model, launcher, threads }`; leave `.env.local` untouched.
  Assumption: administrator controls the destination/project and installed
  executable directories. This is not a sandbox against same-account mutation.

## Task 3: Native host probe and manifest production

- [x] Add `--inspect-host` to the verified native helper:

```cpp
if (argc == 2 && std::wcscmp(argv[1], L"--inspect-host") == 0) {
    writeHostInformation();
    return 0;
}
```

  Compile probe with helper baseline x64, not `/arch:AVX2`.
  Use `__cpuidex` and check OSXSAVE/AVX plus XCR0 bits 1/2 before reporting AVX2,
  FMA or F16C as usable. BMI2 comes from CPUID leaf 7.
  Query `GlobalMemoryStatusEx`, active logical CPU count, current process-group
  affinity and Job membership. Report versioned JSON without applying any limits.
  Query OS build through `RtlGetVersion` from already loaded ntdll so app-manifest
  version virtualization does not turn the value into a guessed Win11 version.
  Set `jobLimitsKnown:false`; nested effective limits are not fully discovered.

- [x] Extend manifest generator invocation:

```bash
node scripts/voice/package-manifest.mjs DIRECTORY MODEL windows-x64
```

  Existing two-argument Linux invocation is unchanged. Exclude previous
  `candidate.json`, `candidate.sha256` and generated `voice-package.*` from the
  inventoried payload to avoid self-reference. Assign `bin/voice-job.exe` helper
  role on Windows and validate the complete manifest before writing it.
  Windows build script emits both inventory forms with explicit candidate status.
  Do not claim the application CLI admits the new Windows format yet.

## Task 4: Real import and corruption regression

- [x] Add test that reads the actual version 2 manifest produced in CI and
  imports it into a Unicode/spaced temporary project. Before success, exercise
  wrong manifest hash, truncated helper and symlink helper and require errors
  with no staged files/configuration changes.
- [x] Restore originals, import correctly, require returned helper path, log
  CPU/memory guidance and no new caps. Run the actual `transcribeVoice` against
  imported real model and pinned JFK at the model's default threads.
- [x] Repeat import for idempotence; alter installed binary and require refusal.
  Verify the project `.env.local` sentinel is byte-for-byte unchanged throughout.
  Finally remove only the test's resolved temporary root.
- [x] Push, dispatch Windows native candidates and Linux setup integrity:

```bash
gh workflow run voice-windows-packages.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
gh workflow run voice-setup.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

  Inspect both model jobs and the Linux existing-package integrity jobs.
  Record all run/commit/artifact identities, not only a generic green label.

## Task 5: Persist boundary and continue configuration integration

- [x] Update spec/ledger to state verified import is implemented, but Windows
  CLI activation/menu and setup/deploy upgrades remain gated. Preserve old
  candidate/source evidence and expired-artifact warnings.
- [ ] Next bounded plan: UTF-8/BOM/UTF-16LE config decoding, common path quoting
  with PowerShell/Next.js, private Windows env/receipt writes and rollback,
  service-account override checks, setup/deploy re-entry after pulling and
  repeated interactive upgrades. Only then remove Windows enablement guard.

All commits include the standard Copilot trailer. No new model or resource-policy
decision is introduced by this prerequisite slice.

## Execution evidence

Test-first `e2096bb`, Actions `35981279455`: expected schema/module failures.
Implementation `0637dbc`, final guard/test `1bc1299`.
Windows real candidate/import matrix `35981880883` and lifecycle/runtime
`35981880643` passed. Linux setup `35981511559` at `0637dbc` passed eight contracts
and both existing-model integrity jobs. Final artifacts: Sense `10800701498`,
Whisper `10800204124`. Exact hashes/retention are recorded in
`scripts/VOICE-DEPLOYMENT.txt`. No local validation or production changes.
