import { execFile, fork } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fixture, ready } from './deployment-linux-service-fixture.mjs';
import { saveRecoveryEngine, retirementRecoveryInvocation } from '../scripts/deployment/saved-recovery-engine.mjs';

const execute = promisify(execFile);

export async function interrupted(t, phase = 'retirement-unlink-0', outcome = 'accepted', workerMode = 'none', existing = null) {
  const f = existing ?? await fixture(t);
  await ready(f);
  const control = path.join(path.dirname(f.project), 'control');
  const source = path.join(f.project, 'scripts', 'deployment');
  if (!existing) {
    await mkdir(control, { mode: 0o700 });
    await mkdir(path.join(control, 'backup'));
    await writeFile(path.join(control, 'backup', 'sentinel'), 'retained complete backup');
    await cp(fileURLToPath(new URL('../scripts/deployment/', import.meta.url)), source, { recursive: true });
  }
  const saved = await saveRecoveryEngine({ source, control });
  const child = fork(new URL('./deployment-service-stop-child.mjs', import.meta.url),
    [control, f.project, f.unit, f.npm, f.node, phase, outcome, workerMode],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const { lock } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Retirement did not pause: ${diagnostic}`)), 45000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Retirement exited ${code}: ${diagnostic}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const kill = async () => { child.kill('SIGKILL'); await exited; };
  const recover = async () => {
    const command = retirementRecoveryInvocation(saved, {
      control, project: f.project, operationId: lock.operationId, kind: 'service',
    });
    return execute(command.file, command.args, { env: command.env, timeout: 90000, maxBuffer: 8192 });
  };
  return { ...f, control, source, saved, lock, kill, recover };
}

export async function pausedRecovery(t, f, pause) {
  const child = fork(new URL('./deployment-service-recovery-child.mjs', import.meta.url),
    [f.control, f.project, f.lock.operationId, f.saved.manifestSha256, pause],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Recovery did not pause: ${diagnostic}`)), 60000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Recovery exited ${code}: ${diagnostic}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return async () => { child.kill('SIGKILL'); await exited; };
}
