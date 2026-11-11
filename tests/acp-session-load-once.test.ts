// loadSessionOnce (lib/acp/runtimeState.ts): concurrent session/load calls for
// the same session must share one RPC, otherwise the agent subscribes twice and
// every streamed chunk is duplicated in the chat.
// Locally: npx --yes --package=tsx@4.20.6 tsx --test tests/acp-session-load-once.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { getReplayBuffers, loadSessionOnce } from '../lib/acp/runtimeState';
import type { AgentProcess } from '../lib/acp/types';

function fakeProc(fail = false) {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const proc = {
    knownSessions: new Set<string>(),
    rpc: {
      send: async (method: string, params: { sessionId: string }) => {
        calls.push(method);
        // Simulate the agent replaying history while the load is in flight.
        getReplayBuffers().get(params.sessionId)?.push({ role: 'agent', text: 'hello' });
        await gate;
        if (fail) throw new Error('load failed');
        return {};
      },
    },
  } as unknown as AgentProcess;
  return { proc, calls, release };
}

test('concurrent loads of one session send a single session/load and share the replay', async () => {
  const { proc, calls, release } = fakeProc();
  const a = loadSessionOnce(proc, 's1', async () => ({}));
  const b = loadSessionOnce(proc, 's1', async () => ({}));
  await new Promise((r) => setTimeout(r, 0));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(calls, ['session/load']);
  assert.deepEqual(ra, [{ role: 'agent', text: 'hello' }]);
  assert.equal(ra, rb);
  assert.ok(proc.knownSessions.has('s1'));
  assert.equal(getReplayBuffers().has('s1'), false);
  assert.equal(proc.loadingSessions?.has('s1'), false);
});

test('a failed load rejects every waiter and allows a later retry', async () => {
  const { proc, calls, release } = fakeProc(true);
  const a = loadSessionOnce(proc, 's2', async () => ({}));
  const b = loadSessionOnce(proc, 's2', async () => ({}));
  release();
  await assert.rejects(a, /load failed/);
  await assert.rejects(b, /load failed/);
  assert.equal(calls.length, 1);
  assert.equal(proc.knownSessions.has('s2'), false);
  assert.equal(proc.loadingSessions?.has('s2'), false);
  await assert.rejects(loadSessionOnce(proc, 's2', async () => ({})), /load failed/);
  assert.equal(calls.length, 2);
});
