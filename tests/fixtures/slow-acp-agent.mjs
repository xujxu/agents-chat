import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// Holds each prompt open long enough for a test to queue follow-ups, then reports
// how many distinct `queued-item-N` markers the prompt carried.
// Like real agents, a cancelled prompt resolves only after SLOW_AGENT_CANCEL_DELAY_MS,
// and a prompt sent while the session is still busy is rejected (and counted).
const delayMs = Number(process.env.SLOW_AGENT_DELAY_MS || 8000);
const initDelayMs = Number(process.env.SLOW_AGENT_INIT_DELAY_MS || 0);
const cancelDelayMs = Number(process.env.SLOW_AGENT_CANCEL_DELAY_MS || 0);
const input = createInterface({ input: process.stdin });
const write = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const busy = new Map();
let turns = 0;
let rejected = 0;

function finish(sessionId, text, stopReason) {
  const pending = busy.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  busy.delete(sessionId);
  const suffix = rejected ? ` (${rejected} overlapping prompts rejected)` : '';
  write({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${text}${suffix}` } } } });
  write({ id: pending.requestId, result: { stopReason } });
}

input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'session/cancel') {
    if (request.id !== undefined) write({ id: request.id, result: {} });
    const sessionId = request.params?.sessionId;
    const pending = busy.get(sessionId);
    if (pending && !pending.cancelling) {
      pending.cancelling = true;
      setTimeout(() => finish(sessionId, `Turn ${pending.turn} cancelled`, 'cancelled'), cancelDelayMs);
    }
    return;
  }
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    setTimeout(() => write({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }), initDelayMs);
  } else if (request.method === 'session/new') {
    write({ id: request.id, result: { sessionId: randomUUID() } });
  } else if (request.method === 'session/prompt') {
    const { sessionId } = request.params;
    if (busy.has(sessionId)) {
      rejected++;
      write({ id: request.id, error: { code: -32000, message: 'A prompt is already in progress for this session' } });
      return;
    }
    const turn = ++turns;
    const markers = new Set(JSON.stringify(request.params.prompt).match(/queued-item-\d+/g) || []);
    const pending = { requestId: request.id, turn, cancelling: false, timer: undefined };
    pending.timer = setTimeout(() => finish(sessionId, `Turn ${turn} done; saw ${markers.size} queued items`, 'end_turn'), delayMs);
    busy.set(sessionId, pending);
  } else {
    write({ id: request.id, error: { code: -32601, message: `Unsupported fixture method: ${request.method}` } });
  }
});
input.on('close', () => process.exit(0));
