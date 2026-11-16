// resolveMessageWindowStart (app/features/messages/messageWindow.ts): long chats render only
// the newest messages, and the window must stay put as replies are appended.
// Locally: npx --yes --package=tsx@4.20.6 tsx --test tests/message-window.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { MESSAGE_WINDOW_STEP, resolveMessageWindowStart } from '../app/features/messages/messageWindow';

const ids = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `m${index}` }));

test('starts with the newest messages and renders short chats whole', () => {
  assert.equal(resolveMessageWindowStart(ids(100), undefined), 100 - MESSAGE_WINDOW_STEP);
  assert.equal(resolveMessageWindowStart(ids(MESSAGE_WINDOW_STEP), undefined), 0);
  assert.equal(resolveMessageWindowStart([], undefined), 0);
});

test('keeps the chosen start when new messages are appended', () => {
  assert.equal(resolveMessageWindowStart(ids(150), 'm60'), 60);
  assert.equal(resolveMessageWindowStart(ids(150), null), 0);
});

test('falls back to the newest messages when the start message is gone', () => {
  assert.equal(resolveMessageWindowStart(ids(100), 'missing'), 100 - MESSAGE_WINDOW_STEP);
});
