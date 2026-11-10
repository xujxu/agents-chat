import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('follow-up queue store keeps per-user order, versions and atomic take/restore', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'agents-chat-followups-'));
  try {
    process.chdir(dir);
    const { getDb, deleteChat, saveChat } = await import('../lib/chatStore');
    const q = await import('../lib/followupQueue');

    assert.deepEqual(q.addFollowup('u', { chatId: 'c', agentId: 'a', text: '   ' }), { ok: false, error: 'empty' });
    assert.deepEqual(q.addFollowup('u', { chatId: 'c', agentId: 'a', text: 'x'.repeat(q.MAX_FOLLOWUP_TEXT_LENGTH + 1) }), { ok: false, error: 'too_long' });
    const first = q.addFollowup('u', { chatId: 'c', agentId: 'a', text: ' first ', modelId: 'm1' });
    const second = q.addFollowup('u', { chatId: 'c', agentId: 'a', text: 'second' });
    q.addFollowup('other', { chatId: 'c', agentId: 'a', text: 'not mine' });
    assert.ok(first.ok && second.ok);
    assert.deepEqual(q.listFollowups('u', 'c').map(item => item.text), ['first', 'second']);
    assert.deepEqual(q.countFollowupsByChat('u'), { c: 2 });

    const edited = q.updateFollowup('u', first.item.id, 'first edited', first.item.version);
    assert.ok(edited.ok && edited.item.version === 2);
    assert.deepEqual(q.updateFollowup('u', first.item.id, 'stale', 1), { ok: false, error: 'conflict' });
    assert.deepEqual(q.updateFollowup('other', first.item.id, 'hijack', 2), { ok: false, error: 'missing' });

    const taken = q.takeFollowups('u', 'c', 'a');
    assert.deepEqual(taken.map(item => item.text), ['first edited', 'second']);
    assert.deepEqual(q.listFollowups('u', 'c'), []);
    assert.deepEqual(q.takeFollowups('u', 'c', 'a'), []);
    q.restoreFollowups('u', taken);
    assert.deepEqual(q.listFollowups('u', 'c').map(item => [item.text, item.modelId]), [['first edited', 'm1'], ['second', undefined]]);

    assert.equal(q.removeFollowup('other', second.item.id), false);
    assert.equal(q.removeFollowup('u', second.item.id), true);
    for (let i = 1; i < q.MAX_FOLLOWUPS_PER_CHAT; i++) assert.ok(q.addFollowup('u', { chatId: 'c', agentId: 'a', text: `n${i}` }).ok);
    assert.deepEqual(q.addFollowup('u', { chatId: 'c', agentId: 'a', text: 'overflow' }), { ok: false, error: 'queue_full' });

    await saveChat('u', { id: 'c', name: 'Chat', ts: 1, messages: [] });
    await deleteChat('u', 'c');
    assert.deepEqual(q.listFollowups('u', 'c'), []);
    assert.equal(q.listFollowups('other', 'c').length, 1);
    getDb().close();
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('combineFollowups sends one item verbatim and numbers several', async () => {
  const { combineFollowups } = await import('../lib/followupQueue');
  assert.equal(combineFollowups([{ text: ' only ' }]), 'only');
  assert.equal(combineFollowups([{ text: 'a' }, { text: 'b' }]), 'Follow-ups queued while you were working:\n\n1. a\n\n2. b');
});
