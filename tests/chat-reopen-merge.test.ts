import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '../app/features/chat/chatTypes';
import { mergeReopenedChatMessages } from '../app/features/chat/chatHelpers';

const msg = (id: string, type: ChatMessage['type'], content: string, ts: number) => ({ id, type, content, ts }) as ChatMessage;

test('a reopened cached chat takes the server copy but keeps unsaved local changes and notices', () => {
  const cached = [
    msg('u1', 'user', 'q1', 1),
    msg('r1', 'agent', 'stale answer', 2),
    msg('gone', 'agent', 'removed on another device', 3),
    msg('n1', 'system', 'local notice', 4),
    msg('r-live', 'agent', 'streaming here, not saved yet', 5),
    msg('u-new', 'user', 'typed here, not saved yet', 9),
  ];
  const server = [
    msg('u1', 'user', 'q1', 1),
    msg('r1', 'agent', 'answer finished elsewhere', 2),
    msg('r-live', 'agent', 'older saved copy', 5),
    msg('u2', 'user', 'from laptop', 6),
    msg('r2', 'agent', 'reply from laptop', 7),
  ];
  const merged = mergeReopenedChatMessages(server, cached, new Set(['r-live', 'u-new']));
  assert.deepEqual(merged.map(m => [m.id, m.content]), [
    ['u1', 'q1'],
    ['r1', 'answer finished elsewhere'],
    ['n1', 'local notice'],
    ['r-live', 'streaming here, not saved yet'],
    ['u2', 'from laptop'],
    ['r2', 'reply from laptop'],
    ['u-new', 'typed here, not saved yet'],
  ]);
});
