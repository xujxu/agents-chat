import assert from 'node:assert/strict';
import test from 'node:test';

test('cold retirement requires explicit acknowledgement and honors cancellation before admission', async () => {
  const { retireWindowsColdRestoredDeployment } =
    await import('../scripts/deployment/windows-cold-deployment-retirement.mjs');
  assert.equal(typeof retireWindowsColdRestoredDeployment, 'function');
  await assert.rejects(retireWindowsColdRestoredDeployment(), /data-loss acknowledgement/);
  await assert.rejects(retireWindowsColdRestoredDeployment({
    acceptDataLoss: true, onProgress: 42,
  }), /progress callback/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(retireWindowsColdRestoredDeployment({
    acceptDataLoss: true, signal: controller.signal,
  }), { name: 'AbortError' });
});
