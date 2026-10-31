import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { inspectLinuxNodeVersion } from '../scripts/deployment/linux-node-version.mjs';

function fixture(t, stdout = 'v24.1.0\n') {
  const check = t.mock.fn(async () => ({ populated: true }));
  const run = t.mock.fn(async () => ({ stdout, stderr: '' }));
  const node = path.resolve('fixture-node');
  const project = path.resolve('fixture-project');
  const home = path.resolve('fixture-home');
  return {
    node, project, home, run, check, operation: { run },
    service: { check, identity: { runtime: { project, home, user: 'fixture', uid: 123, gid: 456 },
      executables: [{ file: path.resolve('fixture-npm') }, { file: node }] } },
  };
}

test('Node version comes from an owned command under the retained service account', async t => {
  const f = fixture(t);
  const result = await inspectLinuxNodeVersion(f);
  assert.deepEqual(result, { status: 'runtime-observed', platform: 'linux', nodeVersion: '24.1.0' });
  assert.equal(f.run.mock.callCount(), 1);
  const [request] = f.run.mock.calls[0].arguments;
  assert.deepEqual(request.runtime, { uid: 123, gid: 456 });
  assert.equal(request.command.file, f.node);
  assert.deepEqual(request.command.args, ['--version']);
  assert.equal(request.command.cwd, f.project);
  assert.equal(request.command.env.HOME, f.home);
  assert.equal(request.command.env.NODE_OPTIONS, undefined);
  assert.equal(f.check.mock.callCount(), 2);
});

for (const stdout of ['private-invalid-output', 'v24.1.0\nextra', 'v24.1.0-rc.1\n', 'v024.1.0\n']) {
  test(`invalid runtime version output is bounded and sanitized (${stdout.length})`, async t => {
    await assert.rejects(inspectLinuxNodeVersion(fixture(t, stdout)), error => {
      assert.equal(error.code, 'DEPLOYMENT_RUNTIME_UNSUPPORTED');
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-invalid|extra|rc\.1/);
      return true;
    });
  });
}

test('uncertain worker cleanup is never reduced to an ordinary compatibility refusal', async t => {
  const f = fixture(t);
  f.operation.run = async () => { throw Object.assign(new Error('private-command'), { recoveryAllowed: false }); };
  await assert.rejects(inspectLinuxNodeVersion(f), error => {
    assert.equal(error.recoveryAllowed, false);
    assert.equal(error.code, 'DEPLOYMENT_WORKER_UNSETTLED');
    assert.doesNotMatch(JSON.stringify(error) + error.message, /private-command/);
    return true;
  });
});

test('cancellation before admission launches no version command', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = new Error('cancel');
  controller.abort(reason);
  await assert.rejects(inspectLinuxNodeVersion({ ...f, signal: controller.signal }), error => error === reason);
  assert.equal(f.run.mock.callCount(), 0);
});
