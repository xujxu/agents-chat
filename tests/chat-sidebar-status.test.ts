import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '../app/features/chat/chatTypes';
import { getIdleChatStatus } from '../app/features/chat/chatHelpers';

let ts = 0;
const user = (sendStatus?: 'failed'): ChatMessage => ({ id: `u${++ts}`, ts, type: 'user', content: 'hi', ...(sendStatus ? { sendStatus } : {}) } as ChatMessage);
const agent = (content = 'answer'): ChatMessage => ({ id: `a${++ts}`, ts, type: 'agent', content } as ChatMessage);

test('a failed send shows Error until an agent replies after it', () => {
  assert.equal(getIdleChatStatus([user(), agent(), user('failed')])?.kind, 'error');
  assert.equal(getIdleChatStatus([user('failed')])?.kind, 'error');
  assert.equal(getIdleChatStatus([user(), user('failed'), agent(), user(), agent()])?.kind, 'done');
});

test('the last agent reply decides the status otherwise', () => {
  assert.equal(getIdleChatStatus([]), null);
  assert.equal(getIdleChatStatus([user()]), null);
  assert.equal(getIdleChatStatus([user(), agent('⚠️ failed')])?.kind, 'error');
  assert.equal(getIdleChatStatus([user(), agent('⚠️ failed'), user(), agent()])?.kind, 'done');
});
