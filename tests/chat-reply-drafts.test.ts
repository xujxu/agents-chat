import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-chat-reply-drafts-'));
  try {
    process.chdir(dir);
    const store = await import('../lib/chatStore');
    const { commitChatOperation } = await import('../lib/chatSyncStore');
    const db = store.getDb();
    const rawMessages = (chatId: string) => (db.prepare('SELECT messages FROM chats WHERE user_id = ? AND chat_id = ?').get('u1', chatId) as { messages: string }).messages;
    const draftCount = () => (db.prepare('SELECT COUNT(*) AS n FROM chat_reply_drafts').get() as { n: number }).n;
    const reply = (id: string) => async (chatId: string) => (await store.getChat('u1', chatId))?.messages.find(m => m.id === id);

    const user = { id: 'q1', type: 'user' as const, content: 'Question', ts: 1 };
    await store.saveChat('u1', { id: 'chat', name: 'Chat', ts: 1, messages: [user], agentSessions: {} });
    const before = rawMessages('chat');
    const a1 = reply('a1');

    // Streaming snapshots leave the stored history alone but are visible to every reader.
    const snapshot = { id: 'a1', type: 'agent' as const, agentId: 'alpha', ts: 2, pending: true, content: 'Hel', statusText: 'Thinking',
      userRequest: { requestId: 'r1', kind: 'question', prompt: 'Continue?' } } as Parameters<typeof store.saveStreamingReply>[2];
    assert.equal(await store.saveStreamingReply('u1', 'chat', snapshot), true);
    assert.equal(rawMessages('chat'), before, 'a draft does not rewrite the chat');
    let shown = await a1('chat');
    assert.equal(shown?.content, 'Hel');
    assert.equal(shown?.pending, true);
    assert.equal(shown?.serverManaged, true);
    assert.equal(shown?.version, 1);

    // A client save of presentation metadata keeps the draft on top and its own fields.
    commitChatOperation('u1', {
      operationId: 'client-meta',
      chat: { id: 'chat', name: 'Chat', ts: 1, agentSessions: {}, messages: [{ ...shown!, content: 'client text', round: 3 }] },
      expectedVersions: {},
    });
    await store.saveStreamingReply('u1', 'chat', { ...snapshot, content: 'Hello', userRequest: undefined, statusText: 'Generating response' });
    shown = await a1('chat');
    assert.equal(shown?.content, 'Hello');
    assert.equal(shown?.round, 3, 'browser-owned fields survive later snapshots');
    assert.equal(shown?.userRequest, undefined, 'a field dropped from the snapshot is cleared');
    assert.ok((shown?.version || 0) > 1, 'versions keep increasing');
    const streamingVersion = shown!.version!;

    // The finished reply is written once, above every draft version, and the draft is dropped.
    await store.updateChatMessage('u1', 'chat', { ...snapshot, content: 'Hello world', pending: false, statusText: undefined, userRequest: undefined });
    shown = await a1('chat');
    assert.equal(shown?.content, 'Hello world');
    assert.equal(shown?.pending, false);
    assert.equal(shown?.round, 3);
    assert.ok(shown!.version! > streamingVersion);
    assert.equal(draftCount(), 0);
    assert.equal(JSON.parse(rawMessages('chat')).find((m: { id: string }) => m.id === 'a1').content, 'Hello world');

    // A reply left streaming by a restart is interrupted from its draft and does not come back.
    await store.saveStreamingReply('u1', 'chat', { ...snapshot, id: 'a2', ts: 3, content: 'Partial' });
    assert.equal(await store.reconcileStalePendingMessagesForAgent('u1', 'chat', 'alpha'), true);
    const interrupted = await reply('a2')('chat');
    assert.equal(interrupted?.content, 'Partial');
    assert.equal(interrupted?.pending, false);
    assert.equal(interrupted?.cutOff, true);
    assert.equal(draftCount(), 0);

    // Removing a streaming reply removes its draft.
    await store.saveStreamingReply('u1', 'chat', { ...snapshot, id: 'a3', ts: 4, content: 'Doomed' });
    const doomed = await reply('a3')('chat');
    commitChatOperation('u1', {
      operationId: 'client-remove',
      chat: { id: 'chat', name: 'Chat', ts: 1, agentSessions: {}, messages: [], removedMessageIds: ['a3'] },
      expectedVersions: { a3: doomed!.version! },
    });
    assert.equal(await reply('a3')('chat'), undefined);
    assert.equal(draftCount(), 0);

    // Deleted or missing chats keep no drafts.
    await store.saveStreamingReply('u1', 'chat', { ...snapshot, id: 'a4', ts: 5 });
    await store.deleteChat('u1', 'chat');
    assert.equal(draftCount(), 0);
    assert.equal(await store.saveStreamingReply('u1', 'chat', { ...snapshot, id: 'a5', ts: 6 }), false);
    assert.equal(draftCount(), 0);
  } finally {
    try { (await import('../lib/chatStore')).getDb().close(); } catch { /* not opened */ }
    process.chdir(originalCwd);
    await rm(dir, { recursive: true });
  }
  console.log('chat reply draft tests passed');
}

void main();
