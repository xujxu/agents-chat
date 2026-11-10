import assert from 'node:assert/strict';
import test from 'node:test';
import { REPLY_GUIDELINES, withReplyGuidelines, withReplyGuidelinesOnce } from '../lib/acp/replyGuidelines';

test('guidelines are sent once per agent session', () => {
  const first = withReplyGuidelinesOnce('session-a', 'What is bug 5809224?');
  assert.ok(first.includes(REPLY_GUIDELINES) && first.endsWith('[User message]\nWhat is bug 5809224?'));
  assert.equal(withReplyGuidelinesOnce('session-a', 'And the next one?'), 'And the next one?');
  assert.ok(withReplyGuidelinesOnce('session-b', 'hi').includes(REPLY_GUIDELINES), 'a new or recovered session gets them again');
});

test('attachment-only prompts keep a user instruction', () => {
  assert.ok(withReplyGuidelines('  ').endsWith('[User message]\nPlease review the attached file(s).'));
});
