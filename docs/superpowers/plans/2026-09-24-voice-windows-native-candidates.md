# Windows Native Voice Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build pinned real Windows x64 Sense and Whisper candidate artifacts and prove that each works through the application's native transcriber.

**Architecture:** Keep the existing installer catalogue unchanged until actual binaries are qualified. A dispatch-only Windows matrix builds each engine, embeds UTF-8 application settings, inventories the exact helper/model/runtime files and runs real transcription from Unicode paths. Candidate inventory is deliberately not an installer-admitted manifest.

**Tech Stack:** Windows Server Actions runner, MSVC/CMake, PowerShell 7, existing Node/tsx tests and native Job helper.

---

## Execution checkpoint (2026-09-24)

Tasks 1-3 and Task 4's evidence step are complete. Test-first Actions
`35977443809` failed for missing inventory. First build `35977603961` passed
Whisper but exposed Python's Windows-default source encoding in the Sense patch
tool. Fix `37f6612` selects explicit UTF-8/LF without changing patch replacements.

Final Actions `35977946646` passed both real model jobs. Both ran through the
application transcriber from Unicode/spaced paths at all three thread counts.
Artifacts: Sense `10799057231`, Whisper `10799410956`. See
`scripts/VOICE-DEPLOYMENT.txt` for exact artifact digests, build provenance and
scope. No model artifacts were downloaded onto the development host.

Task 4's separate installation/upgrade plan is the next task. Candidate inventories
remain deliberately unrecognized by the Linux-only installer; public release,
full-corpus and actual Win11 qualification are not complete.

## Scope, prior evidence and execution

User approved the parent spec and inline execution. Shared Windows runtime
`852fcc1` passed Actions `35975644625`; milestone documentation is `4490617`.
This stage precedes the separate Windows installation/upgrade plan.

All compilation, inference and audio work runs in Actions. Never modify PROD,
cpg or sampler. Do not create a release or a permanent download catalogue.
No local dependencies, models or test servers.

Windows Server success is not Win11 qualification. JFK audio is a launch/path/
delivery smoke, not a multilingual accuracy or latency benchmark. Measured smoke
timing must not be presented as frozen-corpus acceptance.

## Files and ownership

| Path | Purpose |
| --- | --- |
| `.github/workflows/voice-windows-packages.yml` | Dispatch two-model matrix; retain successful candidate artifacts or bounded failure diagnostics |
| `scripts/voice/windows/build-candidate.ps1` | Fetch pins, build static CPU engines/helper, embed manifest, retain source/build/dependency notices |
| `scripts/voice/windows/utf8.manifest` | Windows process active UTF-8 codepage, required by narrow-argument upstream CLIs |
| `scripts/voice/windows/candidate-inventory.mjs` | SHA256/size inventory with pinned model identity, explicitly not installer manifest |
| `tests/voice-windows-native.test.ts` | Validate files, real model delivery at supported thread counts, Unicode paths and cleanup |
| `scripts/VOICE-DEPLOYMENT.txt`, formal spec | Exact evidence and remaining qualification/installation gates |

Do not modify `install-package.mjs` to accept a speculative Windows format.
The Linux manifest and installer behavior remain intact.

## Task 1: Red real-package contract

- [ ] Create `tests/voice-windows-native.test.ts`. Require
  `VOICE_CANDIDATE_DIRECTORY` and `VOICE_INSTALL_AUDIO`; absence must fail, not skip.
  Test header and executable entry:

```ts
test('real Windows candidate transcribes through the application from Unicode paths',
  { timeout: 420000 }, async () => {
    assert.equal(process.platform, 'win32');
    assert.ok(process.env.VOICE_CANDIDATE_DIRECTORY);
    assert.ok(process.env.VOICE_INSTALL_AUDIO);
    const root = path.resolve(process.env.VOICE_CANDIDATE_DIRECTORY);
    const inventory = JSON.parse(await readFile(path.join(root, 'candidate.json'), 'utf8'));
    assert.equal(inventory.kind, 'windows-native-build-candidate');
    assert.equal(inventory.qualification, 'smoke-only-not-release-approved');
  });
```

  Validate every inventory entry's SHA256/bytes against disk. Resolve the single
  engine, helper and model role; verify exact known model hash independent of
  inventory. Copy candidate to a random directory whose name contains spaces
  and Chinese characters. Use existing `voiceConfiguration` and `transcribeVoice`,
  never run a separate decoder to stand in for application integration.
  Exercise threads 1, 2, 4, require `/country/i` for the pinned JFK sample, and
  require no leaked `agents-chat-voice-*` request directories. Use `finally`
  cleanup and a 120-second per-request deadline.

- [ ] Add an initial dispatch workflow that installs Node dependencies and
  invokes the test without producing a candidate. Push it and dispatch one
  test-first run. Expected failure is missing `candidate.json`, not a native
  compiler failure. Preserve the red run ID.

```bash
gh workflow run voice-windows-packages.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
gh run list -R xujxu/agents-chat --workflow voice-windows-packages.yml --limit 3 --json databaseId,headSha,status,conclusion
```

## Task 2: Build exact Windows binaries

- [ ] Add a Windows manifest with:

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
</assembly>
```

  Pass `/MANIFEST:EMBED /MANIFESTINPUT:<absolute manifest>` to the MSVC linker.
  Preserve extracted embedded-manifest evidence. Real non-ASCII paths must pass;
  using only ASCII runner paths is not sufficient.

- [ ] Build script accepts only
  `[ValidateSet('sensevoice-small-q8','whisper-base-q5_1')] $Model`.
  Use exact pins already verified on Linux:

| Asset | Pin |
| --- | --- |
| FunASR | `3ff9259aade4f7e4360645df28cad8f81959ee91` |
| llama.cpp | `803b7fcae893e9caaee3921779628fef83ac0965` |
| Sense weights revision | `90c1c61912018b70ada0fcc024ea24aca62f2e63` |
| Sense SHA256 | `4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5` |
| whisper.cpp and JFK sample | `5670d5c0bbcb148feabef84400a07cfca9aa3b30` |
| Whisper SHA256 | `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898` |
| OpenAI weight-license file revision | `6e3be77e1a105e59086e3e21ff5f609fd6fa89a5` |

  Fetch source archives by revision, calculate archive SHA256 and retain those
  observed source hashes. Whisper weight URL currently uses upstream `main`;
  byte identity is enforced by the fixed SHA256, never by that mutable label.
  Download via `curl.exe --fail --location --retry 3 --max-time 600`, checking
  exit status before extracting. Apply the existing Sense thread/error patch
  unchanged and retain its generated diff.

- [ ] Use Visual Studio 2022 x64, Release, `BUILD_SHARED_LIBS=OFF`,
  `CMAKE_POLICY_DEFAULT_CMP0091=NEW`, `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`,
  `GGML_NATIVE=OFF`, explicit AVX/AVX2/FMA/F16C/BMI2, AVX512 off,
  OpenMP/CUDA/Vulkan/BLAS/backend-DL off. Disable Whisper server/tests/curl.
  Build only `llama-funasr-sensevoice` or `whisper-cli`, parallel 2.
  Compile the current `voice-job.cpp` and `voice-files.cpp` with `/MT` and
  `Advapi32.lib`; keep helper separate from model executable.

- [ ] Use `vswhere` and `VsDevCmd.bat` only to select the installed compiler.
  Run `dumpbin /dependents` for both shipped executables; retain full output,
  reject non-system DLLs (including `VCRUNTIME`, `MSVCP`, ggml or OpenMP DLLs).
  An unexpected dependency blocks the candidate, not a reason to copy random
  runner DLLs. Extract the embedded manifest with `mt.exe`.

- [ ] Retain actual source licenses, Sense model card/Apache notice, ggml/
  miniaudio notices and exact model/build source pins. Record MSVC toolchain/
  static-runtime use and relevant Microsoft redistribution documentation URL.
  Do not label the whole binary MIT-only or claim package-wide legal clearance.
  The repository has no root license discovered: redistribution permission for
  the application-owned helper needs explicit resolution before a public release.
  This does not block private CI build experiments; it does block claiming a
  redistributable public installation package is approved.

## Task 3: Candidate inventory and real smoke

- [ ] Write a separate `candidate.json` and `candidate.sha256`:

```js
const inventory = {
  version: 1,
  kind: 'windows-native-build-candidate',
  platform: 'windows-x64',
  modelId,
  qualification: 'smoke-only-not-release-approved',
  cpuFlags: ['avx2', 'fma', 'f16c', 'bmi2'],
  files,
};
```

  Walk regular files only, reject symlinks and empty files, sort paths, record
  SHA256/bytes; exactly one `engine`, one `helper`, one pinned `model`, and
  source `license`/`provenance` files. Do not name this `voice-package.json`.
  Hash the complete inventory from outside it. The existing importer must still
  reject these artifacts until platform compatibility/import is implemented.

- [ ] Dispatch the two-model workflow: checkout, Node24, Python3, npm ci,
  build script, inventory, real smoke. Independent matrix jobs prevent a failing
  engine from hiding the other result. No full-corpus inference in this slice.
  Retain successful candidate package for 30 days; on failure retain build
  diagnostics only, not a success-shaped package.

- [ ] Read both job outcomes and native logs; iterate failures via pushed fixes.
  All fixes must preserve pinned model identity, source provenance, no hard
  runtime quotas and the real Unicode-path test. Do not replace the model with
  a fixture or silently change precision to make a smoke pass.

## Task 4: Evidence and next stage

- [ ] Commit run IDs, per-model outcome, SHA256, compiler/OS/dependency evidence
  and artifact IDs. Record whether threads/path handling passed for each model.
  No speech accuracy/latency recommendation follows from this smoke.
- [ ] Write the separate package import/setup/deploy plan against actual built
  artifacts. It must cover helper-role validation, Windows CPU checks,
  ACL/encoding/path behavior, private receipts and rollback, every interactive
  upgrade prompting/default keep, unattended preservation and opt-out.

All commits include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
The feature is not complete until the remaining installation and real-platform/
quality/distribution gates are satisfied.
