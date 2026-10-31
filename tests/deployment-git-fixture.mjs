import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { temporaryDeployment } from './deployment-fixture.mjs';

const execute = promisify(execFile);
export async function git(project, ...args) {
  return (await execute('git', ['-C', project, ...args], { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

export async function gitWindowsSecurity(file, action = 'inspect') {
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./deployment-windows-snapshot-security-fixture.ps1', import.meta.url)),
    '-File', file, '-Action', action], { timeout: 30000, maxBuffer: 65536 });
  return JSON.parse(stdout);
}

export async function gitMetadataFixture(t, { broad = false } = {}) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, broad ? 'app' : 'source with spaces');
  await mkdir(project);
  if (broad) await gitWindowsSecurity(project, 'broaden-inheritable');
  await git(project, 'init', '--initial-branch=main');
  await git(project, 'config', 'user.name', 'Deployment fixture');
  await git(project, 'config', 'user.email', 'fixture@example.invalid');
  await git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, 'app.txt'), 'original\n');
  await git(project, 'add', 'app.txt');
  await git(project, 'commit', '-m', 'original');
  return { root, project, commit: await git(project, 'rev-parse', 'HEAD') };
}
