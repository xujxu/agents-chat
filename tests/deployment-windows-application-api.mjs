import assert from 'node:assert/strict';
import { loginDeploymentFixture } from './deployment-http-fixture.mjs';
import { verifyHttpReadiness } from '../scripts/deployment/http-readiness.mjs';

const [mode, chatId] = process.argv.slice(2);
assert.ok(['create', 'mutate', 'restored'].includes(mode), 'An explicit API fixture phase is required.');
assert.match(chatId ?? '', /^[a-zA-Z0-9-]+$/);
await verifyHttpReadiness({ port: 3010, providers: ['admin-login'] });
const api = await loginDeploymentFixture();
const originalName = 'Before native maintenance';
const content = 'Managed Windows data survives restoration';
if (mode === 'create') {
  assert.equal((await api('/api/chats', { chat: {
    id: chatId, name: originalName, ts: Date.now(), agentSessions: {},
    messages: [{ id: 'original', type: 'user', content, ts: Date.now() }],
  } })).ok, true);
} else if (mode === 'mutate') {
  assert.equal((await api(`/api/chats?id=${chatId}`)).chat.name, originalName);
  assert.equal((await api('/api/chats', {
    action: 'rename', chatId, name: 'After native maintenance',
  })).ok, true);
}
const chat = (await api(`/api/chats?id=${chatId}`)).chat;
assert.equal(chat.name, mode === 'mutate' ? 'After native maintenance' : originalName);
assert.equal(chat.messages[0].content, content);
console.log(`PASS: managed Windows application API ${mode}`);
