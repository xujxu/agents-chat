// Regression: an agent reply must never sort above the user prompt that triggered it.
// User prompts are stamped with the browser clock, so the persisted reply must reuse the
// browser-stamped pending message ts instead of the (possibly skewed) server clock.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const route = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('../app/features/chat/runtime/chatAcpService.ts', import.meta.url), 'utf8');

assert.match(client, /sendBody\.messageTs = pendingMessage\.ts/, 'client should send the pending message ts with the prompt');
assert.match(route, /typeof body\?\.messageTs === 'number'/, 'send action should read messageTs from the request');
assert.match(route, /messageTs: messageTs \?\? startedAt/, 'turn should fall back to server time only when messageTs is missing');
assert.match(route, /ts: turn\.messageTs,/, 'persisted agent message should use the client-provided ts');
assert.doesNotMatch(route, /ts: turn\.startedAt,/, 'persisted agent message must not use the server clock');

console.log('agent message order checks passed');
