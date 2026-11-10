import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// Holds each prompt open long enough for a test to queue follow-ups, then reports
// how many distinct `queued-item-N` markers the prompt carried.
const delayMs = Number(process.env.SLOW_AGENT_DELAY_MS || 8000);
const initDelayMs = Number(process.env.SLOW_AGENT_INIT_DELAY_MS || 0);
const input = createInterface({ input: process.stdin });
const write = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let turns = 0;
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    setTimeout(() => write({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }), initDelayMs);
  } else if (request.method === 'session/new') {
    write({ id: request.id, result: { sessionId: randomUUID() } });
  } else if (request.method === 'session/prompt') {
    const turn = ++turns;
    const text = JSON.stringify(request.params.prompt);
    const markers = new Set(text.match(/queued-item-\d+/g) || []);
    setTimeout(() => {
      write({
        method: 'session/update',
        params: {
          sessionId: request.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Turn ${turn} done; saw ${markers.size} queued items` } },
        },
      });
      write({ id: request.id, result: { stopReason: 'end_turn' } });
    }, delayMs);
  } else {
    write({ id: request.id, error: { code: -32601, message: `Unsupported fixture method: ${request.method}` } });
  }
});
input.on('close', () => process.exit(0));
