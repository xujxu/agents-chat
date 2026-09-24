# Windows Voice Process Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an independently testable Windows x64 native launcher that owns and tears down a trusted engine's process tree without imposing CPU or memory quotas.

**Architecture:** A short-lived native launcher owns a kill-on-close Job Object. Node keeps a control pipe open; EOF, cancellation, deadline or engine completion ends the Job. Assign the engine to the Job atomically at creation, before its suspended thread can run.

**Tech Stack:** C++17, Win32 Job/process APIs, MSVC, Node built-in test runner, GitHub Actions Windows runner.

---

## Approval, scope and staged delivery

The user approved
[`2026-09-24-install-selected-voice-input-design.md`](../specs/2026-09-24-install-selected-voice-input-design.md)
after commit `98e06ce`, including native Windows 11 Intel/AMD x64 rather than WSL.
This is the first bounded execution plan, **not a claim that the complete feature
has been planned at code level or implemented**.

The implementation sequence is:

| Stage | Output and boundary |
| --- | --- |
| 1: this plan | Native launcher, explicit failure contract, Windows lifecycle tests and retained Actions evidence; no change to available models |
| 2: runtime integration | Separate plan after stage 1: `lib/voice/process.ts`, configuration/provider/transcriber integration, private temp files and platform output handling; preserve Linux legacy behavior |
| 3: packages and installation | Separate plan: Windows pinned Sense/Whisper builds, manifest/dependency checks, dotenv/ACL/atomic transaction, PowerShell setup/deploy and standalone inclusion |
| 4: qualification and distribution | Separate plan: exact installed-package corpus/API/browser gates, actual Win11 Actions runner, reviewed licenses and trusted permanent downloads |

Do not enable Windows in `parseVoiceConfiguration`, remove unsupported notices,
publish runtime assets, or advertise Windows support in this stage.
No production/cpg/sampler changes. No local validation, builds or test processes.
All executable examples below are **planned file contents**, not code to run
while reviewing this document.

The existing Windows hosted runner is a Windows Server environment. Its results
are launcher-development evidence, not final Windows 11 acceptance.

### Lifecycle refinement

The approved spec describes suspended creation followed by Job assignment.
Use `PROC_THREAD_ATTRIBUTE_JOB_LIST` during `CreateProcessW`, with
`CREATE_SUSPENDED`, rather than leaving a create-then-assign gap. Otherwise killing
the launcher between those two calls can leak a suspended engine.
This API is supported since Windows 10/Server 2016, inside the selected target.
Fail closed if the attribute cannot be applied; do not fall back to an unowned
process or request Job breakaway.

Sources:
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Process attributes, including Job and handle lists](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)

## File map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `scripts/voice/windows/voice-job.cpp` | Native launch, argument quoting, Job ownership, timeout/control-pipe supervision |
| Create | `tests/fixtures/voice-windows-engine.mjs` | Trusted synthetic engine, real descendant creation, output/argument fixtures |
| Create | `tests/fixtures/voice-windows-parent.mjs` | Separate Node parent for genuine parent-death test |
| Create | `tests/fixtures/voice-windows-policy.cpp` | Query actual inner Job limit flags, without production test switches |
| Create | `tests/voice-windows-job.test.mjs` | Real native launcher contract/lifecycle tests |
| Create | `.github/workflows/voice-windows-process.yml` | Actions-only native compilation and tests |
| Modify | `scripts/VOICE-DEPLOYMENT.txt` | Append exact run/commit evidence after success |
| Modify | formal voice spec | Record approval and atomic Job assignment detail, without claiming Windows release completion |

Build outputs live under ignored `.data/voice-windows-build/`; retain only
synthetic evidence and binaries as CI artifacts. Do not include environment files
or recovery receipts.

## Task 1: Establish a red Windows contract run

**Files:** create the workflow, JS fixtures and JS tests listed above.

- [ ] **Step 1: Add the synthetic engine fixture.**

`tests/fixtures/voice-windows-engine.mjs`:

```js
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [mode, file, ...values] = process.argv.slice(2);
if (mode === 'args') {
  process.stdout.write(JSON.stringify([file, ...values]));
} else if (mode === 'exit') {
  process.stderr.write('private native diagnostic');
  process.exitCode = Number(file);
} else if (mode === 'leaf') {
  setInterval(() => {}, 1000);
} else if (mode === 'nested') {
  const child = spawn(file, ['5000', ...values], {
    stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
  });
  child.once('error', () => process.exit(9));
  child.once('close', code => { process.exitCode = code ?? 9; });
} else if (mode === 'tree' || mode === 'tree-exit') {
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url), 'leaf',
  ], { stdio: 'ignore', windowsHide: true });
  child.once('error', () => process.exit(9));
  child.once('spawn', () => {
    writeFileSync(file, JSON.stringify({ engine: process.pid, descendant: child.pid }));
    if (mode === 'tree-exit') {
      child.unref();
      process.stdout.write('completed');
    } else {
      setInterval(() => {}, 1000);
    }
  });
} else {
  process.exitCode = 10;
}
```

`tests/fixtures/voice-windows-parent.mjs`:

```js
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [launcher, fixture, treeFile, parentFile] = process.argv.slice(2);
const child = spawn(launcher, ['120000', process.execPath, fixture, 'tree', treeFile], {
  stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
});
child.once('error', () => process.exit(9));
child.once('spawn', () => writeFileSync(parentFile, JSON.stringify({ launcher: child.pid })));
setInterval(() => {}, 1000);
```

- [ ] **Step 2: Add concrete lifecycle tests.**

`tests/voice-windows-job.test.mjs`:

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const launcher = path.resolve('.data/voice-windows-build/voice-job.exe');
const policy = path.resolve('.data/voice-windows-build/voice-policy.exe');
const fixture = path.resolve('tests/fixtures/voice-windows-engine.mjs');
const parentFixture = path.resolve('tests/fixtures/voice-windows-parent.mjs');
const pause = () => new Promise(resolve => setTimeout(resolve, 25));

async function until(check, label) {
  const end = Date.now() + 5000;
  do {
    if (await check()) return;
    await pause();
  } while (Date.now() < end);
  assert.fail(label);
}

async function jsonFile(file) {
  let result;
  await until(async () => {
    try { result = JSON.parse(await readFile(file, 'utf8')); return true; }
    catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
      throw error;
    }
  }, `fixture did not become ready: ${path.basename(file)}`);
  return result;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function stop(pid) {
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
}

function run(binary, args) {
  const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  // A killed launcher may close stdin before a cancellation write completes.
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') throw error;
  });
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({
      code, stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
  // Attach immediately so a missing executable cannot become an unhandled rejection.
  void done.catch(() => {});
  return { child, done };
}

test('Windows Job launcher contracts', { timeout: 90000 }, async t => {
  assert.equal(process.platform, 'win32', 'run only in the Windows Actions job');
  const root = await mkdtemp(path.join(tmpdir(), 'voice job \u8bed\u97f3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tracked = new Set();
  t.after(() => { for (const pid of tracked) stop(pid); });
  const start = (binary, args) => {
    const result = run(binary, args);
    if (result.child.pid) tracked.add(result.child.pid);
    return result;
  };
  const engine = (args, deadline = '5000', executable = launcher) =>
    start(executable, [deadline, process.execPath, fixture, ...args]);

  await t.test('exact Unicode, whitespace, quote and backslash arguments; no shell', async () => {
    const args = ['two words', '\u4f60\u597d', '', 'say"hello', 'C:\\trailing\\', '& echo not-a-command'];
    const spaced = path.join(root, 'launcher space.exe');
    await copyFile(launcher, spaced);
    const result = await engine(['args', ...args], '5000', spaced).done;
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), args);
    assert.equal(result.stderr, '');
  });

  await t.test('engine exit preserved and private native stderr not forwarded', async () => {
    assert.deepEqual(await engine(['exit', '7']).done, { code: 7, stdout: '', stderr: '' });
  });

  await t.test('missing executable is an explicit sanitized failure', async () => {
    const result = await start(launcher, ['5000', path.join(root, 'missing.exe')]).done;
    assert.equal(result.code, 125);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^voice_job_error:\d+\r?\n$/);
    assert.ok(!result.stderr.includes(root));
  });

  await t.test('inner Job sets lifecycle only, including when nested', async () => {
    for (const args of [
      ['5000', policy],
      ['10000', process.execPath, fixture, 'nested', launcher, policy],
    ]) {
      const result = await start(launcher, args).done;
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        limitFlags: 8192, cpuControlFlags: 0,
      });
    }
  });

  for (const mode of ['eof', 'cancel', 'deadline', 'launcher-death', 'engine-exit']) {
    await t.test(`tears down real descendants: ${mode}`, async () => {
      const file = path.join(root, `${mode}.json`);
      const job = engine([mode === 'engine-exit' ? 'tree-exit' : 'tree', file],
        mode === 'deadline' ? '2000' : '15000');
      const pids = await jsonFile(file);
      tracked.add(pids.engine); tracked.add(pids.descendant);
      if (mode !== 'engine-exit') {
        assert.ok(alive(pids.engine));
        assert.ok(alive(pids.descendant));
      }
      if (mode === 'eof') job.child.stdin.end();
      if (mode === 'cancel') job.child.stdin.write('cancel\n');
      if (mode === 'launcher-death') job.child.kill('SIGKILL');
      const result = await job.done;
      if (mode === 'eof' || mode === 'cancel') assert.equal(result.code, 126);
      if (mode === 'deadline') assert.equal(result.code, 124);
      if (mode === 'engine-exit') {
        assert.equal(result.code, 0);
        assert.equal(result.stdout, 'completed');
      }
      await until(() => !alive(pids.engine) && !alive(pids.descendant),
        `${mode} left running processes`);
    });
  }

  await t.test('actual Node-parent death closes control without inherited writers', async () => {
    const treeFile = path.join(root, 'parent-tree.json');
    const parentFile = path.join(root, 'parent-launcher.json');
    const parent = start(process.execPath, [
      parentFixture, launcher, fixture, treeFile, parentFile,
    ]);
    const [pids, owner] = await Promise.all([jsonFile(treeFile), jsonFile(parentFile)]);
    tracked.add(pids.engine); tracked.add(pids.descendant); tracked.add(owner.launcher);
    assert.ok(alive(pids.engine) && alive(pids.descendant));
    parent.child.kill('SIGKILL');
    await parent.done;
    await until(() => !alive(owner.launcher) && !alive(pids.engine) && !alive(pids.descendant),
      'parent death leaked its launcher or engine tree');
  });

  await t.test('repeated early cancellation does not spawn a late engine', async () => {
    for (let i = 0; i < 12; i++) {
      const job = engine(['args', 'unused']);
      job.child.stdin.end();
      const result = await job.done;
      assert.ok(result.code === 126 || result.code === 0);
      // 0 is possible only if the short engine completed before cancellation.
      if (result.code === 0) assert.equal(result.stdout, '["unused"]');
    }
  });
});
```

Do not mistake early cancellation of a short fixture for proof against every
creation-time race; that guarantee comes from atomic Job assignment plus the
forced launcher-death and descendant tests.
The nested fixture creates its own inner control pipe. Directly making a launcher
the engine of another launcher would deliberately give it `NUL` for stdin and
test an invalid control transport instead of nested-Job compatibility.

- [ ] **Step 3: Add the dedicated workflow.**

`.github/workflows/voice-windows-process.yml`:

```yaml
name: Voice Windows process foundation
on:
  push:
    branches: [experiment/voice-natural-long]
    paths:
      - 'scripts/voice/windows/**'
      - 'tests/voice-windows-job.test.mjs'
      - 'tests/fixtures/voice-windows-*'
      - '.github/workflows/voice-windows-process.yml'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  lifecycle:
    runs-on: windows-2022
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.20.0
      - name: Compile if native sources exist
        shell: pwsh
        run: |
          if (!(Test-Path scripts/voice/windows/voice-job.cpp)) {
            Write-Host 'Test-first checkpoint: native launcher not implemented'
            exit 0
          }
          New-Item -ItemType Directory -Force .data/voice-windows-build | Out-Null
          $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
          $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
          if (!$vs) { throw 'MSVC x64 build tools missing' }
          $devcmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
          $job = 'cl /nologo /W4 /WX /EHsc /std:c++17 /MT /DUNICODE /D_UNICODE scripts\voice\windows\voice-job.cpp /Fo.data\voice-windows-build\voice-job.obj /Fe.data\voice-windows-build\voice-job.exe'
          $fixture = 'cl /nologo /W4 /WX /EHsc /std:c++17 /MT /DUNICODE /D_UNICODE tests\fixtures\voice-windows-policy.cpp /Fo.data\voice-windows-build\voice-policy.obj /Fe.data\voice-windows-build\voice-policy.exe'
          cmd /d /s /c "`"$devcmd`" -arch=x64 -host_arch=x64 && $job && $fixture"
          if ($LASTEXITCODE -ne 0) { throw 'Native compilation failed' }
      - name: Exercise owned process trees
        shell: pwsh
        run: node --test --test-concurrency=1 tests/voice-windows-job.test.mjs
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: voice-windows-process-${{ github.sha }}
          path: .data/voice-windows-build/*.exe
          if-no-files-found: ignore
          retention-days: 14
```

- [ ] **Step 4: Commit and push only these test/workflow files.**

```bash
git add .github/workflows/voice-windows-process.yml tests/voice-windows-job.test.mjs tests/fixtures/voice-windows-engine.mjs tests/fixtures/voice-windows-parent.mjs
git commit -m "test: specify native Windows voice process ownership" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin HEAD:experiment/voice-natural-long
gh run list --workflow voice-windows-process.yml --branch experiment/voice-natural-long --limit 3 --json databaseId,headSha,status,conclusion
```

- [ ] **Step 5: Inspect the run for this commit, not an older passing run.**

```bash
gh run view RUN_ID --log-failed
```

Replace `RUN_ID` with the matching `databaseId`. Expected red reason:
missing `voice-job.exe` / `ENOENT`. A runner/toolchain failure is not the intended
red test. Correct workflow infrastructure first if necessary. Do not compile
anything on the development host.

## Task 2: Implement the native owned-process launcher

**Files:** create `scripts/voice/windows/voice-job.cpp` and
`tests/fixtures/voice-windows-policy.cpp`.

- [ ] **Step 1: Add the launcher below.**

`scripts/voice/windows/voice-job.cpp`:

```cpp
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <stdexcept>
#include <string>
#include <vector>

struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    ~Handle() {
        if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
    }
};

struct Attributes {
    std::vector<unsigned char> storage;
    LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
    ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
};

void require(BOOL ok) {
    if (!ok) throw std::runtime_error("win32");
}

std::wstring quote(const std::wstring& input) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t value : input) {
        if (value == L'\\') { ++slashes; continue; }
        if (value == L'"') result.append(slashes * 2 + 1, L'\\');
        else result.append(slashes, L'\\');
        slashes = 0;
        result.push_back(value);
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'"');
    return result;
}

bool cancelled(HANDLE control) {
    DWORD bytes = 0;
    if (PeekNamedPipe(control, nullptr, 0, nullptr, &bytes, nullptr)) return bytes != 0;
    if (GetLastError() == ERROR_BROKEN_PIPE) return true;
    throw std::runtime_error("control");
}

void terminateAndWait(HANDLE job) {
    require(TerminateJobObject(job, 126));
    const ULONGLONG end = GetTickCount64() + 5000;
    for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        require(QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
            &accounting, sizeof(accounting), nullptr));
        if (accounting.ActiveProcesses == 0) return;
        if (GetTickCount64() >= end) {
            SetLastError(WAIT_TIMEOUT);
            throw std::runtime_error("teardown");
        }
        Sleep(10);
    }
}

int execute(int argc, wchar_t** argv) {
    if (argc < 3) { SetLastError(ERROR_INVALID_PARAMETER); throw std::runtime_error("args"); }
    wchar_t* end = nullptr;
    const unsigned long timeout = std::wcstoul(argv[1], &end, 10);
    if (!*argv[1] || *end || timeout == 0 || timeout > 120000) {
        SetLastError(ERROR_INVALID_PARAMETER);
        throw std::runtime_error("deadline");
    }
    const std::wstring executable = argv[2];
    // This foundation only accepts absolute local drive paths.
    if (executable.size() < 3 || executable[1] != L':' ||
        (executable[2] != L'\\' && executable[2] != L'/')) {
        SetLastError(ERROR_BAD_PATHNAME);
        throw std::runtime_error("path");
    }
    HANDLE control = GetStdHandle(STD_INPUT_HANDLE);
    if (cancelled(control)) return 126;
    const ULONGLONG deadline = GetTickCount64() + timeout;

    Handle job;
    job.value = CreateJobObjectW(nullptr, nullptr);
    require(job.value != nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
        &limits, sizeof(limits)));

    SECURITY_ATTRIBUTES inherit{ sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
    Handle input, output, errorOutput;
    input.value = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(input.value != INVALID_HANDLE_VALUE);
    errorOutput.value = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(errorOutput.value != INVALID_HANDLE_VALUE);
    require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE),
        GetCurrentProcess(), &output.value, 0, TRUE, DUPLICATE_SAME_ACCESS));
    HANDLE inherited[] = { input.value, output.value, errorOutput.value };

    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
    if (!bytes) throw std::runtime_error("attributes");
    Attributes attributes;
    attributes.storage.resize(bytes);
    auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.storage.data());
    require(InitializeProcThreadAttributeList(list, 2, 0, &bytes));
    attributes.list = list;
    require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited, sizeof(inherited), nullptr, nullptr));
    require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        &job.value, sizeof(job.value), nullptr, nullptr));

    std::wstring command;
    for (int i = 2; i < argc; ++i) {
        if (i != 2) command.push_back(L' ');
        command += quote(argv[i]);
    }
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input.value;
    startup.StartupInfo.hStdOutput = output.value;
    startup.StartupInfo.hStdError = errorOutput.value;
    startup.lpAttributeList = list;
    PROCESS_INFORMATION info{};
    require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
        nullptr, nullptr, &startup.StartupInfo, &info));
    Handle process, thread;
    process.value = info.hProcess;
    thread.value = info.hThread;
    BOOL owned = FALSE;
    require(IsProcessInJob(process.value, job.value, &owned));
    require(owned);
    if (cancelled(control)) { terminateAndWait(job.value); return 126; }
    require(ResumeThread(thread.value) != static_cast<DWORD>(-1));

    DWORD result = 125;
    for (;;) {
        const DWORD wait = WaitForSingleObject(process.value, 20);
        if (wait == WAIT_OBJECT_0) {
            require(GetExitCodeProcess(process.value, &result));
            break;
        }
        if (wait != WAIT_TIMEOUT) throw std::runtime_error("wait");
        if (cancelled(control)) { result = 126; break; }
        if (GetTickCount64() >= deadline) { result = 124; break; }
    }
    terminateAndWait(job.value);
    return static_cast<int>(result);
}

int wmain(int argc, wchar_t** argv) {
    try { return execute(argc, argv); }
    catch (const std::exception&) {
        std::fprintf(stderr, "voice_job_error:%lu\n", GetLastError());
        return 125;
    }
}
```

This executable intentionally accepts only a trusted local executable and already
prepared argument vector. The future TypeScript boundary must whitelist the
launcher/engine, sanitize environment, bound captured stdout, decode strictly and
map request cancellation through existing `VoiceError` behavior.
Do not expose this CLI as an arbitrary executable HTTP endpoint.

Exit statuses: engine status on completion, 124 deadline, 125 supervisor failure,
126 control closure/cancellation. Engine status collisions are not proof of
launcher error: the future adapter must use its own cancellation/deadline state
and sanitized supervisor diagnostic to distinguish outcomes.

- [ ] **Step 2: Add a test-only policy probe.**

`tests/fixtures/voice-windows-policy.cpp`:

```cpp
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>

int main() {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
    if (!QueryInformationJobObject(nullptr, JobObjectExtendedLimitInformation,
        &limits, sizeof(limits), nullptr)) return 1;
    if (!QueryInformationJobObject(nullptr, JobObjectCpuRateControlInformation,
        &cpu, sizeof(cpu), nullptr)) return 2;
    std::printf("{\"limitFlags\":%lu,\"cpuControlFlags\":%lu}",
        limits.BasicLimitInformation.LimitFlags, cpu.ControlFlags);
    return 0;
}
```

The expected inner-Job limit is exactly `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
(`0x2000`), with no CPU control flags. This checks what was actually installed,
not merely a comment or a 400 MiB allocation. Outer runner/administrator Job
constraints can still apply.

- [ ] **Step 3: Push the native implementation and inspect Actions.**

```bash
git add scripts/voice/windows/voice-job.cpp tests/fixtures/voice-windows-policy.cpp
git commit -m "feat: supervise Windows voice engines with lifecycle-only Jobs" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin HEAD:experiment/voice-natural-long
gh run list --workflow voice-windows-process.yml --branch experiment/voice-natural-long --limit 3 --json databaseId,headSha,status,conclusion
```

Expected: both native files compile with warnings treated as errors, all fixture
tests pass, and the job retains the exact binaries. Investigate failures using
`gh run view RUN_ID --log-failed`; push fixes and repeat. Neither this document
nor plausible-looking code establishes that Node pipe handles work with
`PeekNamedPipe` on the runner: the parent-death/EOF tests are mandatory.

If Node's actual pipe implementation cannot support that control contract,
replace only the control transport with an explicitly created named pipe and
retain the same tests/ownership guarantees. Do not silently ignore pipe errors
or substitute PID-only cancellation. Record that change in the plan/spec before
integrating with the app.

## Task 3: Close the development gate and prepare the next bounded plan

**Files:** workflow, spec and `scripts/VOICE-DEPLOYMENT.txt`.

- [ ] **Step 1: Remove the temporary test-first compilation escape.**

Delete this exact block from the workflow after the implementation exists:

```powershell
if (!(Test-Path scripts/voice/windows/voice-job.cpp)) {
  Write-Host 'Test-first checkpoint: native launcher not implemented'
  exit 0
}
```

Rename the step to `Compile native launcher and policy fixture`. A missing
source must now be a build failure, not silently defer to tests.

- [ ] **Step 2: Commit/push and record the final run for that exact commit.**

```bash
git add .github/workflows/voice-windows-process.yml
git commit -m "ci: require Windows voice launcher sources" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin HEAD:experiment/voice-natural-long
gh run list --workflow voice-windows-process.yml --branch experiment/voice-natural-long --limit 3 --json databaseId,headSha,status,conclusion
```

Do not run unrelated Linux inference/browser suites for this isolated native
addition. The application code and configuration availability are unchanged.
Once runtime integration begins, run the existing Linux provider workflow and
its dispatch-only API/browser coverage as well.

- [ ] **Step 3: Append factual evidence after the final Actions run passes.**

Include actual commit SHA, run URL, runner OS/build, compiler version, artifact
ID and each exercised termination mode. State explicitly: no model weights
downloaded, no model quality measurement, no app integration yet, no Windows 11
claim from a Windows Server runner. Never write a green result before observing it.
Commit that evidence with the Copilot trailer and push.

- [ ] **Step 4: Write the next runtime-integration plan against the validated files.**

Save it as
`docs/superpowers/plans/2026-09-24-voice-windows-runtime-integration.md`.
Read only the then-current `lib/voice/configuration.ts`, `providers.ts`,
`transcriber.ts`, `jobs.ts` and their targeted tests. Its required gates are:
preserve Linux arguments/policies, validate Windows paths/launcher, control-pipe
lifetime, strict bounded output, private Windows request directories, Windows
Whisper file safety, cancellation/cleanup and real API fixture tests.
Do not relax Windows availability until those gates and runtime dependencies
are implemented.

## Self-review and requirement coverage

This plan implements the spec's Windows lifecycle prerequisite: Unicode native
launch, no shell, hidden console, handle allowlist, atomic Job membership,
owned-descendant teardown, control EOF, cancellation, timeout, parent death,
nested Jobs and absence of application CPU/RAM caps.

The following are intentionally **not covered by stage 1** and cannot be claimed
done: actual model binaries and DLL dependencies; service-account environment;
private request directories; Windows output-file validation; setup/upgrade/
rollback; model menu enablement; UI/API integration; final package latency/
accuracy; real Win11 acceptance; permanent download distribution.
Each belongs to stages 2-4 above and requires its own concrete plan before code.

Do not create an all-purpose supervisor framework, persistent worker, new Node
native-addon dependency, production quota knob or Windows service as part of
this bounded foundation.
