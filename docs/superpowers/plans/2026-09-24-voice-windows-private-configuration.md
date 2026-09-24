# Windows Voice Private Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve legacy configuration bytes on keep/rollback and create private Windows configuration/receipt files before connecting Windows model selection to setup/deploy.

**Architecture:** Isolate environment byte decoding and recovery format from platform file writes. On Windows, create an ACL-protected temporary directory using Windows PowerShell 5.1/.NET Framework, write and flush within it, then rename the file on the same volume. Preserve Linux private-file behavior and existing receipts. Do not enable Windows model selection in this slice.

**Tech Stack:** Dependency-free Node ESM, Windows PowerShell 5.1, .NET Framework DirectorySecurity, node:test and GitHub Actions.

---

## Boundaries

Parent specification and inline execution are already approved. Import milestone
`80458aa` records successful real Windows packages. This plan closes the private
configuration prerequisite; setup/deploy re-entry, task identity/environment,
upgrade menus and actual installed-configuration model activation follow in a
separate integration slice. No startup prompts, service changes or public release.
All execution is in Actions; no local tests, build or model execution.

Administrator-controlled project/configuration directories are required.
Private files grant access to the current installer identity, SYSTEM and
Administrators. A differently owned service must not be enabled until the
integration layer explicitly checks that identity. This is not isolation from
the same account or administrators.

## File map

| File | Responsibility |
| --- | --- |
| `scripts/voice/configuration-files.mjs` | Strict UTF8/BOM/UTF16LE decoding, byte snapshots, private atomic writes and regular-file checks |
| `scripts/voice/windows/private-directory.ps1` | Create a new NTFS directory with a protected inheritable DACL from creation, no secret input/output |
| `scripts/configure-voice.mjs` | Use raw bytes for compare/receipt/rollback; retain legacy receipt compatibility and Windows enablement gate |
| `scripts/voice/setup-config.mjs` | Manage launcher key and serialize Windows paths with forward slashes, not JSON backslash escapes |
| `tests/voice-setup-files.test.mjs` | Pure codecs, CLI encoding/rollback, failed write and Windows ACL checks |
| `.github/workflows/voice-setup.yml` | Run contracts on Linux plus separate Windows file/CLI contracts |

## Task 1: Red encoding and recovery tests

- [ ] Add a test covering UTF8, UTF8 BOM and UTF16LE BOM:

```js
const text = 'OTHER=\u4e2d\u6587\r\nVOICE_ENABLED=1\r\n';
const originals = [
  Buffer.from(text),
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
];
for (const original of originals) {
  assert.equal(decodeEnvironment(original), text);
  await writeFile(file, original);
  assert.equal(invoke('--non-interactive').status, 0);
  assert.deepEqual(await readFile(file), original);
  assert.equal(invoke('--model', 'disabled', '--receipt', receipt).status, 0);
  assert.equal(invoke('--rollback-receipt', receipt).status, 0);
  assert.deepEqual(await readFile(file), original);
}
assert.throws(() => decodeEnvironment(Buffer.from([0xff])), /encoding/);
assert.throws(() => decodeEnvironment(Buffer.from([0xff, 0xfe, 0x61])), /encoding/);
```

- [ ] Add a launcher/path serialization assertion:

```js
const text = updateVoiceEnvironment('VOICE_LAUNCHER_PATH=old\n', 'sensevoice-small-q8', {
  binary: 'C:\\voice folder\\engine.exe', launcher: 'C:\\voice folder\\voice-job.exe',
  model: 'C:\\voice folder\\model.gguf', threads: 2,
});
assert.match(text, /VOICE_LAUNCHER_PATH="C:\/voice folder\/voice-job.exe"/);
assert.doesNotMatch(updateVoiceEnvironment(text, 'disabled'), /LAUNCHER_PATH/);
```

- [ ] Commit/push tests and the Linux runner selector. Expected failure is missing
  `configuration-files.mjs` / missing launcher serialization, not infrastructure.
  Inspect `gh run view RUN -R xujxu/agents-chat --log-failed`.

## Task 2: Byte-preserving configuration transaction

- [ ] Export these functions from `configuration-files.mjs`:

```js
export function decodeEnvironment(bytes) {
  if (bytes === null) return '';
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  try {
    const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('NUL');
    return text;
  } catch { throw new Error('Unsupported environment encoding; expected UTF-8 or BOM-marked UTF-16LE.'); }
}
export function encodeEnvironment(text) {
  return Buffer.from((process.platform === 'win32' ? '\ufeff' : '') + text, 'utf8');
}
```

  Windows output includes UTF8 BOM so Windows PowerShell 5.1's existing readers
  decode it correctly; Next.js dotenv accepts the BOM. Keep and rollback retain
  original bytes, including UTF16LE and line endings.

- [ ] Read only ordinary single-link files; reject symlink/hardlink targets.
  Use `Buffer.equals` for concurrent-edit refusal, not decoded-string equality.
  Write recovery before configuration. New receipts have version 2 and base64
  previous bytes; accept old unversioned receipts whose previous value is UTF8.
  Strictly check canonical base64 before restoring. Guard null/missing separately.
  Hash the exact installed bytes, including BOM, for rollback refusal.

```js
const receipt = {
  version: 2, changed: true, file,
  previous: original === null ? null : original.toString('base64'),
  installedSha: digest(next),
};
```

- [ ] Extend the managed-key regex with `LAUNCHER_PATH`. Include
  `VOICE_LAUNCHER_PATH` only when returned configuration has a launcher. For such
  Windows configurations, replace backslashes in the three paths with `/`
  before existing quoting, and reject embedded quote/control/expansion characters.
  Preserve Linux backslash semantics and unrelated configuration text.

## Task 3: Windows private writes, before any secret bytes

- [ ] Add the PowerShell helper taking only a destination-directory path through
  `VOICE_PRIVATE_DIRECTORY` in a sanitized child environment. Require local
  drive-absolute NTFS paths; reject reparse components and existing destination.
  Use an unguessable directory name generated by `randomUUID()` in Node.

```powershell
$security = New-Object System.Security.AccessControl.DirectorySecurity
$security.SetAccessRuleProtection($true, $false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($identity in @($sid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $security.AddAccessRule($rule)
}
[System.IO.Directory]::CreateDirectory($target, $security) | Out-Null
```

  Windows PowerShell is selected from SystemRoot, not PATH. No secret content
  enters child arguments, environment or stdout. Bound runtime/output, sanitize
  PowerShell module environment and propagate failure. The creation API receives
  the DACL: do not create publicly and tighten afterward.

- [ ] Write the temp file within that private directory, flush/close, then
  `rename(temp, file)` on the same volume. Never remove the original before rename.
  Linux retains `open('wx', 0o600)` behavior. Both paths use `finally` cleanup.
  Keep receipts private after rename outside the temporary directory; assert the
  actual resultant file ACL, not only its parent's initial ACL.

## Task 4: Remote Windows and Linux validation

- [ ] Add `windows-files` job on `windows-2022`, Node24.20.0, running:

```bash
node --test tests/voice-setup-files.test.mjs
```

  Tests invoke actual Windows PowerShell, inspect final file ACL SIDs and inherited
  access, refuse linked/existing directory cases, force rename failure with a
  directory destination, and require old config plus no leaked temporary stages.
  Probe code prints ACL identity/rights only, never config/receipt values.
  Use Unicode/spaced roots. UTF8/BOM/UTF16LE all pass CLI keep/disable/rollback.
  Modify config after disable and require rollback refusal. Old receipts restore.

- [ ] Run existing Linux configuration/release, PTY and isolated deploy tests;
  dispatch existing-model integrity without rebuilding:

```bash
gh workflow run voice-setup.yml -R xujxu/agents-chat --ref experiment/voice-natural-long
```

- [ ] Record exact commit/run evidence in this plan and the ledger. Keep the
  Windows model-selection gate closed; do not describe private-file success as
  installation/upgrade or Win11 acceptance.
