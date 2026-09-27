import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { acquireRecoveryAdmission } from '../scripts/deployment/linux-recovery-admission.mjs';

test('directory admission remains exclusive after flock child exits and releases on close', async t => {
  const root = await temporaryDeployment(t);
  const first = await acquireRecoveryAdmission(root);
  try {
    await first.check();
    await assert.rejects(acquireRecoveryAdmission(root));
  } finally { await first.close(); }
  const next = await acquireRecoveryAdmission(root);
  await next.close();
});

test('replaced control directory cannot reuse retained admission authority', async t => {
  const root = await temporaryDeployment(t);
  const control = path.join(root, 'control');
  await mkdir(control, { mode: 0o700 });
  const admission = await acquireRecoveryAdmission(control);
  try {
    await rename(control, path.join(root, 'displaced'));
    await mkdir(control, { mode: 0o700 });
    await assert.rejects(admission.check());
  } finally { await admission.close(); }
});

test('actual controller SIGKILL releases native directory admission without deleting any lock path', async t => {
  const root = await temporaryDeployment(t);
  const child = fork(new URL('./deployment-recovery-admission-child.mjs', import.meta.url), [root],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', code => reject(new Error(`Admission child exited ${code}: ${diagnostic}`)));
    child.once('error', reject);
  });
  await assert.rejects(acquireRecoveryAdmission(root));
  child.kill('SIGKILL');
  await exited;
  const next = await acquireRecoveryAdmission(root);
  await next.check();
  await next.close();
});
