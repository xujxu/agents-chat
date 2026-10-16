import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const project = path.resolve('inactive-project');
const taskName = 'Agents-Chat-Inactive-Test';
const configurationSha256 = 'a'.repeat(64);
const retiredRuntime = {
  pid: 1234, identity: '1234:638900000000000000',
  generation: '11111111-1111-4111-8111-111111111111',
  sessionId: 1, configurationSha256, launcherPid: 1235, readySha256: 'b'.repeat(64),
};
const observation = () => ({
  status: 'inactive-task-observed', runtimeAuthority: false,
  project, taskName, definition: '<Task/>', securityDescriptor: 'D:P(A;;FA;;;SY)',
  principalSid: 'S-1-5-18', enabled: false,
  configuration: path.resolve('inactive-bundle', 'configuration.json'),
  configurationSha256, runtime: null, retiredRuntime: { ...retiredRuntime },
});
const capture = async () => (await import('../scripts/deployment/windows-managed-task-observation.mjs'))
  .captureWindowsInactiveTaskObservation;

test('inactive Windows observation preserves a retired identity without inventing a current runtime', async () => {
  const read = await capture();
  const input = observation();
  const value = read(input, project, taskName);
  assert.deepEqual(value, input);
  assert.equal(value.runtime, null);
  assert.equal(value.runtimeAuthority, false);
  assert.equal(Object.hasOwn(value.retiredRuntime, 'instanceGuid'), false);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.retiredRuntime));
  input.retiredRuntime.pid = 9999;
  assert.equal(value.retiredRuntime.pid, 1234);
});

test('inactive Windows observation refuses enabled policy, current authority and incomplete retired evidence', async () => {
  const read = await capture();
  for (const patch of [
    { enabled: true }, { enabled: 'false' }, { runtime: retiredRuntime },
    { runtimeAuthority: true }, { retiredRuntime: null }, { retiredRuntime: {} },
    { status: 'managed-task-observed' }, { lease: 'released' },
    { project: `${project}-foreign` }, { taskName: `${taskName}-foreign` },
    { configurationSha256: 'c'.repeat(64) }, { definition: '' },
    { securityDescriptor: '' }, { principalSid: 'SYSTEM' },
    { configuration: path.resolve('inactive-bundle', 'other.json') },
  ]) {
    assert.throws(() => read({ ...observation(), ...patch }, project, taskName));
  }
});

test('inactive Windows observation rejects malformed retired identities rather than treating them as absence', async () => {
  const read = await capture();
  for (const patch of [
    { pid: 0 }, { identity: '9999:638900000000000000' }, { generation: 'unknown' },
    { instanceGuid: null }, { sessionId: -1 }, { launcherPid: 0 },
    { readySha256: '' }, { configurationSha256: 'c'.repeat(64) },
    { extra: true },
  ]) {
    const input = observation();
    input.retiredRuntime = { ...input.retiredRuntime, ...patch };
    assert.throws(() => read(input, project, taskName));
  }
});
