// loadSessionOnce (lib/acp/runtimeState.ts): concurrent session/load calls for
// the same session must share one RPC, otherwise the agent subscribes twice and
// every streamed chunk is duplicated in the chat.
// Locally: npx --yes --package=tsx@4.20.6 tsx --test tests/acp-session-load-once.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { getReplayBuffers, loadSessionOnce, sendPromptAfterPrior } from '../lib/acp/runtimeState';
import type { AgentProcess, TurnState } from '../lib/acp/types';

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

test('after an agent restart, a new load does not join the load pending on the dead connection', async () => {
  const dead = fakeProc();
  const proc = dead.proc;
  const stale = loadSessionOnce(proc, 's3', async () => ({}));
  await new Promise((r) => setTimeout(r, 0));

  // Agent restarted: same proc object, new rpc, knownSessions cleared.
  const fresh = fakeProc();
  (proc as { rpc: unknown }).rpc = fresh.proc.rpc;
  proc.knownSessions.clear();
  fresh.release();
  const replay = await loadSessionOnce(proc, 's3', async () => ({}));
  assert.deepEqual(fresh.calls, ['session/load']);
  assert.deepEqual(replay, [{ role: 'agent', text: 'hello' }]);
  assert.ok(proc.knownSessions.has('s3'));

  // The stale load finishing late must not mark the session known on the new
  // process or disturb the new entry.
  proc.knownSessions.clear();
  dead.release();
  await stale;
  assert.equal(proc.knownSessions.has('s3'), false);
  assert.equal(proc.loadingSessions?.has('s3'), false);
});

// sendPromptAfterPrior: a prompt sent right after an interrupt must wait for
// the cancelled one to be answered, otherwise the agent's late "Operation
// cancelled" chunk is credited to the new reply.
function promptProc() {
  const sent: string[] = [];
  const answers = new Map<string, () => void>();
  const proc = {
    knownSessions: new Set<string>(),
    rpc: {
      send: (_method: string, params: { prompt: string[] }) => new Promise((resolve) => {
        sent.push(params.prompt[0]);
        answers.set(params.prompt[0], () => resolve({ stopReason: 'end_turn' }));
      }),
    },
  } as unknown as AgentProcess;
  return { proc, sent, answers };
}
const promptTurn = (sessionId: string) => ({ sessionId, done: false, statusText: 'Thinking' }) as TurnState;
const tick = () => new Promise((r) => setTimeout(r, 5));

test('the next prompt on a session is held, and its updates dropped, until the prior one is answered', async () => {
  const { proc, sent, answers } = promptProc();
  const first = sendPromptAfterPrior(proc, promptTurn('p1'), ['first'], 60_000);
  const next = promptTurn('p1');
  const second = sendPromptAfterPrior(proc, next, ['second'], 60_000);
  const other = sendPromptAfterPrior(proc, promptTurn('p2'), ['other'], 60_000);
  await tick();
  assert.deepEqual(sent, ['first', 'other']);
  assert.equal(next.awaitingPrior, true);
  answers.get('first')!();
  await first;
  await tick();
  assert.deepEqual(sent, ['first', 'other', 'second']);
  assert.equal(next.awaitingPrior, false);
  answers.get('second')!();
  answers.get('other')!();
  await Promise.all([second, other]);
});

test('a turn interrupted while waiting is never sent; a hung or pre-restart prior is not waited on for good', async () => {
  const { proc, sent } = promptProc();
  void sendPromptAfterPrior(proc, promptTurn('p3'), ['hung'], 20);
  const interrupted = promptTurn('p3');
  const skipped = sendPromptAfterPrior(proc, interrupted, ['skipped'], 20);
  Object.assign(interrupted, { done: true, statusText: 'Interrupted' });
  assert.deepEqual(await skipped, { stopReason: 'cancelled' });
  assert.equal(interrupted.statusText, 'Interrupted');
  const capped = promptTurn('p3');
  void sendPromptAfterPrior(proc, capped, ['capped'], 20);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(sent, ['hung', 'capped']);
  assert.equal(capped.awaitingPrior, false);
  // After an agent restart, prompts pending on the dead connection are ignored.
  const restarted = promptProc();
  (proc as { rpc: unknown }).rpc = restarted.proc.rpc;
  void sendPromptAfterPrior(proc, promptTurn('p3'), ['fresh'], 60_000);
  await tick();
  assert.deepEqual(restarted.sent, ['fresh']);
  restarted.answers.get('fresh')!();
});