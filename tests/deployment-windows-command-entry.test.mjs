import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const entry = fileURLToPath(new URL('../scripts/deployment/windows-command-entry.mjs', import.meta.url));
const execute = promisify(execFile);

async function invoke(args) {
  assert.ok(await lstat(entry).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }), 'Missing captured Windows command process entry');
  const root = path.join(os.tmpdir(), `agents-command-entry-${randomUUID()}`);
  const command = [entry, 'update', root, `${root}-control`, 'Agents-Entry-Test',
    path.join(root, 'pwsh.exe'), path.join(root, 'git.exe'), path.join(root, 'npm-cli.js'), ...args];
  let output;
  let code = 0;
  try {
    output = await execute(process.execPath, command, { timeout: 30000, maxBuffer: 16384 });
  } catch (error) {
    assert.equal(error.killed, false);
    assert.equal(error.signal, null);
    assert.equal(typeof error.code, 'number');
    code = error.code;
    output = error;
  }
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  await assert.rejects(lstat(`${root}-control`), { code: 'ENOENT' });
  assert.equal(output.stdout.trim().split('\n').length, 1);
  return { code, result: JSON.parse(output.stdout), stderr: output.stderr };
}

test('private Windows command entry returns one JSON help result without installation access', async () => {
  const { code, result, stderr } = await invoke(['--help']);
  assert.equal(code, 0);
  assert.equal(result.status, 'help');
  assert.equal(stderr, '');
});

test('private Windows command entry preserves failure exit status and refuses unsupported modes', async () => {
  const { code, result, stderr } = await invoke(['--wait', '0']);
  assert.equal(code, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED');
  assert.equal(result.closeoutRequired, false);
  assert.equal(result.operationId, null);
  assert.equal(result.recoveryEngine, null);
  assert.match(stderr, /DEPLOYMENT_COMMAND_MODE_UNSUPPORTED/);
});

test('private Windows command entry does not echo rejected arguments or raw error messages', async () => {
  const marker = '--PRIVATE_TEST_ARGUMENT';
  const { code, result, stderr } = await invoke([marker]);
  assert.equal(code, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.closeoutRequired, false);
  assert.ok(Array.isArray(result.diagnostics));
  assert.ok(!JSON.stringify(result).includes(marker));
  assert.ok(!stderr.includes(marker));
});
