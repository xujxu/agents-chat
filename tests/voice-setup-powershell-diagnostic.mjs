import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(path.join(tmpdir(), 'voice-bootstrap-'));
try {
  const system = process.env.SystemRoot;
  const executable = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const minimal = { SystemRoot: system, WINDIR: system, PATH: path.join(system, 'System32') };
  const withTemp = { ...minimal, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const profile = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['userprofile', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'programw6432'].includes(key.toLowerCase())));
  for (const [name, env] of [['minimal', minimal], ['temp', withTemp], ['profile', { ...withTemp, ...profile }]]) {
    for (const kind of ['bootstrap', 'helper']) {
      const start = Date.now();
      const result = spawnSync(executable, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        ...(kind === 'bootstrap' ? ['-Command', "[Console]::WriteLine('bootstrap-ok')"] :
          ['-File', path.resolve('scripts/voice/windows/private-directory.ps1')]),
      ], { timeout: 15000, encoding: 'utf8', env: { ...env, VOICE_PRIVATE_DIRECTORY: path.join(root, name) } });
      console.log(JSON.stringify({ name, kind, ms: Date.now() - start, status: result.status,
        error: result.error?.code, stdout: result.stdout, stderr: result.stderr }));
    }
  }
} finally { await rm(root, { recursive: true, force: true }); }
