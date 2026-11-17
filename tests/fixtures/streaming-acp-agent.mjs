import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// Streams a turn the way Copilot CLI does: a thought, then STREAM_AGENT_TOOLS tool calls each
// followed by a few word-sized text chunks, every STREAM_AGENT_GAP_MS. Ends with "Stream done".
const tools = Number(process.env.STREAM_AGENT_TOOLS || 12);
const gapMs = Number(process.env.STREAM_AGENT_GAP_MS || 100);
const subagent = process.env.STREAM_AGENT_SUBAGENT === '1';
const write = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (sessionId, body) => write({ method: 'session/update', params: { sessionId, update: body } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stream(request) {
  const { sessionId } = request.params;
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning the work' } });
  for (let i = 1; i <= tools; i++) {
    await sleep(gapMs);
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `call-${i}`, status: 'pending', title: `Stream tool ${i}`, rawInput: { step: i } });
    await sleep(gapMs);
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: `call-${i}`, status: 'completed', rawOutput: `result ${i}` });
    for (const word of ['Step ', `${i} `, 'ok. ']) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: word } });
      // A background sub-agent's own stream, tagged the way Copilot CLI tags it.
      if (subagent) for (const sessionUpdate of ['agent_thought_chunk', 'agent_message_chunk']) {
        update(sessionId, { sessionUpdate, content: { type: 'text', text: `SUBAGENT ${i} ` }, _meta: { 'github.com/copilot': { agentId: 'sub-1' } } });
      }
    }
    if (subagent) update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `sub-call-${i}`, status: 'pending', title: `SUBAGENT tool ${i}`, rawInput: {}, _meta: { 'github.com/copilot': { agentId: 'sub-1' } } });
  }
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Stream done' } });
  write({ id: request.id, result: { stopReason: 'end_turn' } });
}

createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') write({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (request.method === 'session/new') write({ id: request.id, result: { sessionId: randomUUID() } });
  else if (request.method === 'session/prompt') void stream(request);
  else write({ id: request.id, error: { code: -32601, message: `Unsupported fixture method: ${request.method}` } });
});
