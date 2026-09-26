import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createVoiceFaultFixture, faultModes } from './helpers/voiceFaultFixture.mjs';

const cases = [
  ['normal', 200, null, 1, 0],
  ['cancel', 499, 'voice_cancelled', 1, 0],
  ['cancel-cleanup-failure', 499, 'voice_cancelled', 1, 1],
  ['cleanup-failure', 500, 'voice_failed', 1, 1],
  ['create-before-failure', 503, 'voice_process_failed', 0, 0],
  ['create-after-failure', 503, 'voice_process_failed', 0, 1],
];
const report = {
  kind: 'vm-boundary-characterization-not-native-windows',
  run: process.env.GITHUB_RUN_ID, harnessSha: process.env.GITHUB_SHA,
  sourceHashes: {}, scenarios: [],
};

after(async () => {
  if (process.env.VOICE_FAULT_REPORT) {
    await writeFile(process.env.VOICE_FAULT_REPORT, JSON.stringify(report, null, 2));
  }
});

for (const [mode, status, code, cleanupAttempts, remainingDirectories] of cases) {
  test(`characterizes ${mode} without claiming native reproduction`, async () => {
    const record = { mode, status: 'incomplete' };
    report.scenarios.push(record);
    let fixture;
    try {
      fixture = await createVoiceFaultFixture();
      report.sourceHashes = fixture.sourceHashes;
      const result = await fixture.request(mode);
      record.observed = result;
      assert.equal(result.status, status);
      assert.equal(result.code, code);
      assert.equal(result.cleanupAttempts, cleanupAttempts);
      assert.equal(result.remainingDirectories, remainingDirectories);
      assert.equal(result.pendingTimers, 0, 'request must release its job timer');
      assert.deepEqual(result.logCodes, code ? [code] : []);
      assert.equal(result.events[0], 'create:start');
      const creationFailure = mode.startsWith('create-');
      assert.equal(result.events.includes('infer:start'), !creationFailure);
      assert.equal(result.events.includes('cleanup:complete'), cleanupAttempts === 1 && remainingDirectories === 0);
      if (cleanupAttempts) {
        assert.ok(result.events.indexOf('cleanup:attempt') > result.events.indexOf('infer:start'));
      }
      if (mode.includes('cleanup-failure')) {
        assert.ok(result.events.includes('cleanup:injected-EPERM'));
        assert.ok(!result.logCodes.includes('EPERM'));
      }
      if (mode === 'create-after-failure') {
        assert.deepEqual(result.events, ['create:start', 'create:owned', 'create:injected-failure']);
      }
      const recovered = await fixture.request('normal');
      record.recovery = recovered;
      assert.equal(recovered.status, 200, 'next request must be admitted');
      assert.equal(recovered.remainingDirectories, remainingDirectories, 'control must not erase earlier residual');
      assert.equal(recovered.cleanupAttempts, 1);
      assert.equal(recovered.pendingTimers, 0);
      assert.equal(Object.keys(fixture.sourceHashes).length, 5);
      for (const hash of Object.values(fixture.sourceHashes)) assert.match(hash, /^[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(record).includes('fixture-private'));
      record.status = 'passed';
    } catch (error) {
      record.failure = error instanceof Error ? error.name : 'unknown';
      throw error;
    } finally { fixture?.dispose(); }
  });
}

test('fixture rejects unknown modes without running a request', async () => {
  assert.deepEqual(faultModes, cases.map(item => item[0]));
  const fixture = await createVoiceFaultFixture();
  try {
    await assert.rejects(fixture.request('unknown'), /Unknown fault mode/);
    const result = await fixture.request('normal');
    assert.equal(result.status, 200);
    assert.equal(result.remainingDirectories, 0);
  } finally { fixture.dispose(); }
});
