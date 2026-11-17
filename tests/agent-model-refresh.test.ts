import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('refreshAgentModels re-reads a stale list from the running agent at most every 10 minutes', async (t) => {
  const originalCwd = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), 'agents-chat-model-refresh-'));
  process.chdir(dir);
  t.after(() => {
    process.chdir(originalCwd);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite may still hold the file on Windows */ }
  });
  const configStore = await import('../lib/configStore');
  const { refreshAgentModels } = await import('../lib/acp/models');
  configStore.createAgent({ id: 'cli', name: 'CLI', models: [{ modelId: 'old-a' }, { modelId: 'old-b' }], defaultModelId: 'old-a', owner: 'admin' });

  let reported = ['old-a', 'new-c'];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const proc = {
    ready: true, cachedCwd: dir, config: configStore.getAgentById('cli'),
    rpc: { send: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'session/new') return { sessionId: `probe-${calls.length}`, models: { currentModelId: 'old-a', availableModels: reported.map(modelId => ({ modelId })) } };
      return {};
    } },
  } as never;
  const ids = (models: { modelId: string }[]) => models.map(m => m.modelId);

  // Concurrent menu opens share one probe, which carries no MCP servers and is closed afterwards.
  const [first, second] = await Promise.all([refreshAgentModels(proc, 'cli'), refreshAgentModels(proc, 'cli')]);
  assert.deepEqual(ids(first), ['old-a', 'new-c']);
  assert.deepEqual(ids(second), ['old-a', 'new-c']);
  assert.deepEqual(calls.map(c => c.method), ['session/new', 'session/close']);
  assert.deepEqual(calls[0].params, { cwd: dir, mcpServers: [] });
  assert.deepEqual(ids(configStore.getAgentById('cli')!.models!), ['old-a', 'new-c'], 'the saved list (Teams /model) is updated too');

  // Within 10 minutes the saved list is returned without asking the agent again.
  reported = ['changed'];
  assert.deepEqual(ids(await refreshAgentModels(proc, 'cli')), ['old-a', 'new-c']);
  assert.equal(calls.length, 2);

  // A stopped agent is never booted just to refresh its list.
  const stopped = { ...(proc as object), ready: false, rpc: null } as never;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 11 * 60_000 });
  assert.deepEqual(ids(await refreshAgentModels(stopped, 'cli')), ['old-a', 'new-c']);
  assert.equal(calls.length, 2);

  // After 10 minutes a running agent is asked again; a failed probe keeps the saved list.
  assert.deepEqual(ids(await refreshAgentModels(proc, 'cli')), ['changed']);
  t.mock.timers.setTime(Date.now() + 11 * 60_000);
  const failing = { ...(proc as object), rpc: { send: async () => { throw new Error('boom'); } } } as never;
  assert.deepEqual(ids(await refreshAgentModels(failing, 'cli')), ['changed']);
});
