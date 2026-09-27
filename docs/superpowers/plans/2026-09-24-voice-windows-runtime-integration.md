# Windows Voice Runtime Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the verified Windows launcher to the existing voice configuration, transcription and authenticated API while retaining Linux behavior.

**Architecture:** Keep model argument construction separate from platform process ownership. Extend the small native helper with secure Windows filesystem operations rather than pretending POSIX modes or `O_NOFOLLOW` protect Windows files. Run the same API/browser contracts with compiled synthetic engines before qualifying real model packages.

**Tech Stack:** Existing strict TypeScript, Node/Next.js, C++17 Win32, node:test/tsx, Playwright and GitHub Actions.

---

## Completed execution checkpoint (2026-09-24)

Tasks 1-6 completed through implementation `852fcc1` using inline execution.
Red evidence: `b8de002`, Windows `35974222190` and Linux `35974222219`.
Windows final Actions `35975644625` passed lifecycle/runtime contracts,
build/typecheck and 36 API/browser tests (two policy-specific skips).
Artifact `10797918486` contains synthetic fixtures, helper and provenance.
Linux Actions `35974609962` passed 37 contracts and 76 Playwright checks
(three policy skips), including the real pinned Sense API smoke.

The ACL inspector initially mixed PowerShell 5 with a PowerShell 7 module
environment. It now uses the runner's `pwsh` and errors explicitly; ACL
assertions remain unchanged. Implementation additionally rejects temporary
volumes without persistent ACL support and distinguishes a supervisor timeout
from an engine that itself exits with status 124.

The checked-in implementation is authoritative over the original sketches.
The next separate plan covers native model packages and installation/upgrade.
No Windows model package, final speech qualification or actual Win11 acceptance
is claimed by this completed fixture integration.

## Scope and execution

The approved cross-platform spec and user-selected inline execution apply.
Start from `a9435ea`; native foundation `684cc30` passed Actions `35972552477`.
Use the current session without spawning implementation agents.

This stage delivers a development runtime path, not a public installable model.
Windows requires explicit model selection, standard policy and a matching native
helper. Windows installer menus, package trust/catalogue, real model/DLL builds,
actual Win11 acceptance and permanent downloads remain separate stages.

Every test/build/server command runs in Actions. Use
`gh ... -R xujxu/agents-chat`; never depend on this checkout's upstream default.
Do not touch PROD, cpg or the sampler.

## File responsibilities

| Path | Change and responsibility |
| --- | --- |
| `lib/voice/configuration.ts` | Add platform/launcher configuration and explicit Windows path/policy checks |
| `lib/voice/providers.ts` | Reuse model arguments; add Windows launcher command; leave Linux file reader intact |
| `lib/voice/process.ts` | Extract the existing spawn/monitor/deadline/output lifecycle and add Windows control-pipe cancellation |
| `lib/voice/windowsNative.ts` | Sanitized environment and bounded invocations of the native filesystem helper |
| `lib/voice/transcriber.ts` | Compose private directory, WAV writing, process execution and platform result reader |
| `scripts/voice/windows/voice-native.h` | Shared native handle/error ownership; no general framework |
| `scripts/voice/windows/voice-files.h` / `voice-files.cpp` | Private Windows directory creation and no-reparse, bounded transcript reading |
| `scripts/voice/windows/voice-job.cpp` | Dispatch filesystem commands before the existing Job-supervised engine path |
| `tests/fixtures/voice-windows-provider.cpp` | Actual Windows executable emulating both provider protocols and descendants |
| `tests/voice-windows-runtime.test.ts` | Config, result, privacy, cancellation, cleanup and environment regressions |
| `.github/workflows/voice-windows-process.yml` | Build helper/fixtures, test runtime; dispatch application API/browser coverage |
| `tests/voice-providers.test.ts` | Existing Linux assertions plus host-independent Windows parser/command assertions |
| `.env.example`, `README.md`, formal spec and evidence ledger | Describe the development path without implying install/release completion |

No new logic belongs in `app/page.tsx` or `ChatPageClient.tsx`. Reuse
`tests/voice-api.spec.ts`, `voice-input.spec.ts`, `voice-disabled.spec.ts` and
`voice-providers-api.spec.ts`; do not weaken their assertions for Windows.

## Task 1: Establish failing runtime contracts remotely

- [ ] Add Windows configuration tests using explicit Windows paths even on Linux:

```ts
const windows = {
  VOICE_ENABLED: '1', VOICE_MODEL: 'sensevoice-small-q8',
  VOICE_BINARY_PATH: 'C:\\voice engine\\engine.exe',
  VOICE_LAUNCHER_PATH: 'C:\\voice engine\\voice-job.exe',
  VOICE_MODEL_PATH: 'C:\\voice engine\\model.gguf',
};
const config = parseVoiceConfiguration(windows, 'win32', 'x64')!;
assert.equal(config.platform, 'win32');
assert.equal(config.launcher, windows.VOICE_LAUNCHER_PATH);
assert.equal(config.resourcePolicy, 'standard');
assert.equal(voiceCommand(config, 'C:\\temp\\audio.wav', 'C:\\temp\\result').command,
  windows.VOICE_LAUNCHER_PATH);
for (const change of [
  { VOICE_LAUNCHER_PATH: undefined },
  { VOICE_BINARY_PATH: 'C:relative.exe' },
  { VOICE_BINARY_PATH: '\\\\server\\share\\engine.exe' },
  { VOICE_MODEL_PATH: 'C:\\model:stream' },
  { VOICE_RESOURCE_POLICY: 'legacy-low-memory' },
  { VOICE_MODEL: undefined },
]) {
  assert.throws(() => parseVoiceConfiguration({ ...windows, ...change }, 'win32', 'x64'),
    /voice_not_configured/);
}
```

- [ ] Add the Windows runtime test to the workflow after compiling its fixture.
  Use `npm ci --no-audit --no-fund` and
  `npx --yes --package=tsx@4.20.6 tsx --test --test-concurrency=1 tests/voice-windows-runtime.test.ts`.
  Test both provider identities. Modes and expected results:

| Mode | Expected |
| --- | --- |
| valid/stderr/memory | Exact `你好，voice PoC.` |
| empty | `voice_no_speech` |
| oversized/invalid/nul | `voice_invalid_result` |
| fail | `voice_inference_failed` |
| missing output (Whisper) | `voice_invalid_result` |
| directory/reparse/hardlink output (Whisper) | `voice_invalid_result` |
| wait | Abort kills actual descendant and removes request directory |

  For every completed case, compare `agents-chat-voice-*` directories before
  and after. During `wait`, inspect the request directory's actual protected
  ACL before cancelling. Verify the runtime's environment excludes a sentinel
  application secret. Early abort must not create a request directory.

- [ ] Push tests before runtime code. The Windows parser must fail with
  `voice_not_configured`; new filesystem helpers may initially be missing.
  Run failure must be application/contract related, not a compiler setup failure.

```bash
git push origin HEAD:experiment/voice-natural-long
gh run list -R xujxu/agents-chat --branch experiment/voice-natural-long --limit 5 --json databaseId,headSha,workflowName,status,conclusion
gh run view RUN_ID -R xujxu/agents-chat --log-failed
```

Replace `RUN_ID` only with the matching commit's run. Include the standard Copilot
co-author trailer on each test/implementation checkpoint commit.

## Task 2: Add the platform contract without changing Linux semantics

- [ ] Add these fields to `VoiceConfiguration`:

```ts
platform: 'linux' | 'win32';
launcher?: string;
```

  Keep legacy normalization explicitly Linux. On Windows require x64, explicit
  `VOICE_MODEL`, `standard` policy and `VOICE_LAUNCHER_PATH`. Validate all Windows
  paths with `path.win32`, not the host platform's `path.isAbsolute`.
  Permit absolute local drive paths, spaces and Unicode; reject relative,
  drive-relative, UNC/device, alternate-stream and NUL paths.
  Require `.exe` for Windows engine/helper. Async checks use readable regular
  files on Windows; Linux preserves `X_OK`, `nice` and `prlimit`.

- [ ] Extract the existing model argument list unchanged. Select the wrapper:

```ts
if (config.platform === 'win32') {
  if (!config.launcher || config.resourcePolicy !== 'standard') {
    throw new VoiceError('voice_not_configured', 503);
  }
  return { command: config.launcher, args: ['120000', config.binary, ...modelArgs] };
}
return {
  command: '/usr/bin/nice',
  args: ['-n', '10', '/usr/bin/prlimit', ...limits, '--core=0', '--', config.binary, ...modelArgs],
};
```

- [ ] Create `windowsNative.ts` with these module boundaries:

```ts
export function windowsVoiceEnvironment(directory: string): NodeJS.ProcessEnv;
export async function createWindowsVoiceDirectory(launcher: string): Promise<string>;
export async function readWindowsVoiceOutput(
  launcher: string, file: string, signal: AbortSignal,
): Promise<Buffer>;
```

  These are the only new helper exports. Environment keys are `SystemRoot`,
  `WINDIR`, `PATH` restricted to Windows/system directories, `TEMP`, `TMP` and
  `NODE_ENV=production`; discover SystemRoot case-insensitively.
  No inherited application secrets or arbitrary inherited PATH.
  Use `execFile` (no shell), `windowsHide:true`, ten-second helper deadline,
  binary output and 32 KiB maximum buffer. Map native file-reader failures to
  `voice_invalid_result`; temp creation failures to `voice_process_failed`.
  Preserve abort reason rather than converting cancellation into invalid output.
  Never log filesystem paths or native diagnostic text.

  Generate request paths with
  `path.join(tmpdir(), 'agents-chat-voice-' + randomUUID())`.
  The helper creates the directory atomically with its private ACL.
  Do not create an insecure directory and then repair its ACL.
  Complete this short creation operation before checking request cancellation,
  so a successful creation always enters the transcriber's `finally` cleanup.

## Task 3: Implement native private filesystem operations

- [ ] Move existing `Handle`, `NativeError` and `require` definitions into
  `voice-native.h` (`#pragma once`, inline `require`) and include it from both
  native files. Keep this a narrow ownership utility.

- [ ] Dispatch exactly two extra forms from `wmain`:

```cpp
if (argc == 3 && std::wcscmp(argv[1], L"--create-directory") == 0) {
    createPrivateDirectory(argv[2]);
    return 0;
}
if (argc == 3 && std::wcscmp(argv[1], L"--read-output") == 0) {
    writeTranscript(argv[2]);
    return 0;
}
```

  Declare those two functions in `voice-files.h`. The normal engine invocation
  remains unchanged and still atomically enters a lifecycle-only Job.

- [ ] Implement `createPrivateDirectory` using the current process token's
  `TokenUser` SID and a protected SDDL DACL:

```cpp
const std::wstring sddl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;"
    + userSid + L")";
```

  Obtain the SID through `OpenProcessToken`, `GetTokenInformation(TokenUser)` and
  `ConvertSidToStringSidW`. Allocate the descriptor with
  `ConvertStringSecurityDescriptorToSecurityDescriptorW`.
  Use it in `SECURITY_ATTRIBUTES` passed directly to `CreateDirectoryW`.
  Free every `LocalAlloc` result with `LocalFree`, close token handles, and
  preserve the original Win32 failure code before cleanup.
  System, trusted administrators and the service identity receive inheritable
  full access; no Users/Everyone/Authenticated Users grant.
  Existing directories are an error, not permission to adopt or delete them.
  Link `Advapi32.lib`.

- [ ] Implement `writeTranscript` using a single file handle:

```cpp
CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
```

  Require `FILE_TYPE_DISK`; reject directory/reparse attributes and
  `nNumberOfLinks != 1` from `GetFileInformationByHandle`.
  Reject lengths above 32768 before reading and read at most 32769 bytes as a
  second bound. Do not permit writer/delete sharing while the handle is open.
  Write raw bytes with `WriteFile` to stdout, avoiding CRT newline conversion.
  The shared TypeScript decoder retains strict UTF-8, NUL and empty checks.
  The request directory is already private, protecting intermediate path
  components from other ordinary accounts; this is not a same-account sandbox.

## Task 4: Wire owned process execution and private cleanup

- [ ] Move the existing spawn promise from `transcriber.ts` into
  `process.ts`, exported as:

```ts
export function runVoiceProcess(
  config: VoiceConfiguration, input: string, output: string, signal: AbortSignal,
): Promise<Buffer>;
```

  Keep stdout's byte bound, original Linux process-group kill, memory monitor,
  deadline, logger fields and failure precedence. On Windows set
  `detached:false`, `windowsHide:true`, pipe stdin and sanitized environment.
  Ordinary cancellation/failure closes stdin, allowing the Job owner to
  terminate **and wait** for descendants. Capture at most 256 bytes of launcher
  stderr solely for sanitized protocol classification; never log it.
  A bounded fallback terminates the launcher if control teardown stalls, marks
  the operation failed and waits for its close event before releasing resources.
  Do not kill the Windows launcher merely because its engine emits a valid
  nonzero status; it already performs Job teardown itself.
  Handle expected EPIPE/ECONNRESET during shutdown without an unhandled event.

- [ ] Replace the transcriber orchestration with this sequence:

```ts
signal.throwIfAborted();
const config = 'modelId' in configuration ? configuration : legacyVoiceConfiguration(configuration);
const directory = config.platform === 'win32'
  ? await createWindowsVoiceDirectory(config.launcher!)
  : await mkdtemp(path.join(tmpdir(), 'agents-chat-voice-'));
try {
  signal.throwIfAborted();
  const input = path.join(directory, 'audio.wav');
  const output = path.join(directory, 'transcript');
  await writeFile(input, audio, { mode: 0o600, signal });
  const stdout = await runVoiceProcess(config, input, output, signal);
  signal.throwIfAborted();
  if (config.provider === 'sensevoice-gguf') return decodeVoiceText(stdout);
  if (config.platform === 'win32') {
    return decodeVoiceText(await readWindowsVoiceOutput(config.launcher!, `${output}.txt`, signal));
  }
  return await readWhisperOutput(`${output}.txt`, signal);
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

  Replace non-null assertions with explicit launcher guards in final code.
  Keep the API route unchanged: its reservation remains held until transcription
  and cleanup settle. Do not add an API bypass for tests.

## Task 5: Exercise both providers through the real application

- [ ] Compile a Windows fixture executable that accepts the real provider
  argument forms (`-m/-a/--threads` or `-m/-f/-of/-otxt`). It reads model fixture
  mode text, writes `child.pid`, emits the same synthetic output as the existing
  Python fixture, and creates an actual descendant for wait/sample 0.4.
  Sample 0.5 touches 400 MiB to retain the standard-mode regression.
  It must create actual file/reparse/hardlink outputs for rejection tests.
  Native fixture stderr is intentionally private.

- [ ] Expand the Windows workflow paths to include `lib/voice/**` and the
  Windows runtime test. Compile `voice-job.cpp` plus `voice-files.cpp`, link
  Advapi32, build the provider fixture, run existing Job tests, new runtime tests
  and `npx tsc --noEmit --incremental false`.

- [ ] For `workflow_dispatch`, additionally install Chromium, run
  `npm run build`, type-check generated routes and start the actual Next server
  using Node directly (not a shell wrapper). Use port 3011 and the existing
  isolated admin/NextAuth test environment.
  For Sense and Whisper in sequence, set explicit Windows helper/engine/model
  paths, `VOICE_API_FIXTURE=1`, `VOICE_EXPECT_POLICY=standard`, appropriate
  `VOICE_EXPECT_MODEL`, and execute:

```bash
npx playwright test --config tests/playwright.config.ts tests/voice-api.spec.ts tests/voice-input.spec.ts --project=desktop-chromium --workers=1 --max-failures=2 --reporter=line
```

  Wait for `/api/auth/providers` readiness before tests. Always stop the exact
  recorded server process, wait for exit and ensure no request directories
  remain before moving to the next mode. Invalid and disabled phases use the
  existing corresponding API/browser specs.
  Retain synthetic failure traces and build/OS provenance, never environment
  files or receipts. Hosted Windows Server success is not actual Win11 proof.

- [ ] Push implementation, inspect targeted Windows and Linux contract runs,
  then dispatch both Windows and Linux application workflows:

```bash
gh workflow run voice-windows-process.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
gh workflow run voice-providers.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

  Require the unchanged Linux legacy tests and existing real Sense smoke to
  pass. A Windows fixture pass does not qualify a real Windows model.
  Fix observed failures, push and repeat only the affected checks.

## Task 6: Document the precise milestone

- [ ] Document `VOICE_LAUNCHER_PATH` as Windows-only and required, standard-only
  Windows policy, private ACL directory creation and bounded native output read.
  Qualify existing README references to niceness, core dumps and POSIX process
  groups as Linux behavior.
- [ ] Persist exact Actions runs, commits and artifacts. Distinguish Windows
  runtime fixture/API support from missing Windows model packages, installer
  flow and actual Win11/model acceptance.
- [ ] Commit/push docs and update the formal spec status. Write the next
  package/installation plan only after these runtime gates settle.

## Self-review

Configuration and argument construction have a shared API with explicit platform
policy. The process module owns lifetimes, the native filesystem helper owns
Windows filesystem guarantees, and the transcriber composes them without growing
the API or UI shell. Privacy and Windows output safety are prerequisites, not
deferred shortcuts. Linux behavior remains covered by the existing workflows.

Stage boundaries are deliberate: no installer activation, public download,
license-release approval, Windows performance claim or Win11 qualification is
made from synthetic tests. This stage requires no new UI design.
