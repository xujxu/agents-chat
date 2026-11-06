// session/set_model behavior of applySessionModelIfRequested (lib/acp/models.ts).
// Runs in CI (.github/workflows/teams-bot.yml). Locally: npx --yes --package=tsx@4.20.6 tsx --test tests/acp-session-model.test.ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

type Sent = { method: string; params: Record<string, unknown> };

function fakeProc(opts: { env?: Record<string, string>; fail?: (method: string) => Error | null } = {}) {
  const sent: Sent[] = [];
  const proc = {
    config: {
      id: 'agent', name: 'agent', command: 'x',
      models: [{ modelId: 'claude-sonnet-5.5' }, { modelId: 'claude-opus-5.5' }],
      defaultModelId: 'claude-sonnet-5.5',
      ...(opts.env ? { env: JSON.stringify(opts.env) } : {}),
    },
    rpc: {
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        const err = opts.fail?.(method);
        if (err) throw err;
        return {};
      },
    },
  };
  return { proc, sent };
}

test('applySessionModelIfRequested', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-chat-models-'));
  try {
    process.chdir(dir);
    const { applySessionModelIfRequested } = await import('../lib/acp/models');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apply = (proc: any, model: string | undefined) => applySessionModelIfRequested(proc, 's1', model);

    // Nothing requested: no RPC.
    let { proc, sent } = fakeProc();
    await apply(proc, undefined);
    assert.equal(sent.length, 0);

    // The agent's default is still set explicitly: the CLI may run another model than session/new reports.
    ({ proc, sent } = fakeProc());
    await apply(proc, 'claude-sonnet-5.5');
    assert.deepEqual(sent, [{ method: 'session/set_model', params: { sessionId: 's1', modelId: 'claude-sonnet-5.5' } }]);

    // Agents with custom env (proxied Claude Code) keep the old skip for their default model only.
    ({ proc, sent } = fakeProc({ env: { ANTHROPIC_BASE_URL: 'http://proxy' } }));
    await apply(proc, 'claude-sonnet-5.5');
    assert.equal(sent.length, 0);
    await apply(proc, 'claude-opus-5.5');
    assert.equal(sent.length, 1);

    // Falls back to the legacy method name.
    ({ proc, sent } = fakeProc({ fail: (m) => (m === 'session/set_model' ? new Error('Method not found') : null) }));
    await apply(proc, 'claude-opus-5.5');
    assert.deepEqual(sent.map((s) => s.method), ['session/set_model', 'unstable_setSessionModel']);

    // An agent that cannot switch models still works on its default, but fails for other models.
    const unsupported = () => new Error('Method not found');
    ({ proc } = fakeProc({ fail: unsupported }));
    await apply(proc, 'claude-sonnet-5.5');
    await assert.rejects(apply(proc, 'claude-opus-5.5'), /does not support switching to model "claude-opus-5.5"/);

    // A missing session is surfaced even for the default, so the caller can recover the session.
    ({ proc } = fakeProc({ fail: () => new Error('Session s1 not found') }));
    await assert.rejects(apply(proc, 'claude-sonnet-5.5'), /Session s1 not found/);
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
