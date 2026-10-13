import assert from 'node:assert/strict';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { saveRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { invokeSavedWindowsRestore } from './deployment-windows-restore-entry-fixture.mjs';

test('saved Windows restore entry refuses invalid protocol without changing deployment evidence', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, '.app.deployment');
  await mkdir(project, { mode: 0o700 });
  await mkdir(control, { mode: 0o700 });
  const source = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));
  const saved = await saveRecoveryEngine({ source, control });
  const entry = path.join(saved.directory, 'windows-restore-entry.mjs');
  assert.ok(await lstat(entry).then(value => value.isFile(), error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }), 'Saved engine is missing its Windows restore process entry.');
  const input = {
    project, taskName: 'Agents-Saved-Restore-Entry', pwsh: process.env.DEPLOYMENT_TEST_PWSH,
    backup: path.join(control, 'backup'), port: 3010, waitSeconds: 120, timeoutSeconds: 60,
  };
  assert.equal(typeof input.pwsh, 'string');
  const before = (await readdir(control)).sort();
  for (const [name, options, stage, code] of [
    ['acknowledgement', { acknowledge: false }, 'arguments', 'DEPLOYMENT_DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED'],
    ['extra arguments', { extraArgs: ['PRIVATE_RESTORE_INPUT'] }, 'arguments', 'DEPLOYMENT_DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED'],
    ['digest', { manifestSha256: '0'.repeat(64) }, 'engine-verification'],
    ['self location', { entry: path.join(source, 'windows-restore-entry.mjs') }, 'engine-verification'],
    ['unknown fields', { input: { ...input, private: 'PRIVATE_RESTORE_INPUT' } }, 'input'],
    ['deadline', { input: { ...input, timeoutSeconds: 0 } }, 'input'],
    ['port', { input: { ...input, port: 0 } }, 'input'],
    ['backup path', { input: { ...input, backup: path.join(root, 'other-backup') } }, 'input'],
    ['oversized input', { rawInput: ' '.repeat(32769) }, 'input'],
    ['invalid UTF8', { rawInput: Buffer.from([0xff]) }, 'input'],
    ['absent backup', {}, 'backup-engine-binding', 'DEPLOYMENT_BACKUP_MISSING'],
  ]) {
    const output = await invokeSavedWindowsRestore({ saved, control, input, ...options });
    assert.equal(output.code, 1, name);
    assert.equal(output.result.status, 'failed', name);
    assert.equal(output.result.stage, stage, name);
    if (code) assert.equal(output.result.code, code, name);
    assert.equal(output.result.closeoutRequired, false, name);
    const diagnosticLine = output.stderr.trim().split('\n').find(line => line.startsWith('Saved restore diagnostics: '));
    assert.ok(diagnosticLine, `${name}: forwarded stderr must retain bounded saved-engine diagnostics`);
    assert.deepEqual(JSON.parse(diagnosticLine.slice('Saved restore diagnostics: '.length)), output.result.diagnostics, name);
    assert.ok(!JSON.stringify(output).includes('PRIVATE_RESTORE_INPUT'), name);
    assert.deepEqual((await readdir(control)).sort(), before, name);
  }
});
