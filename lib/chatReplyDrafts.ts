import type Database from 'better-sqlite3';
import type { StoredMessage } from './chatStore';

/**
 * In-progress agent replies are saved here instead of rewriting the chat's whole message
 * history every few seconds; the chat row is written once when the reply finishes.
 * Reads layer these drafts over the chat, so callers see the same messages as before.
 */

export const REPLY_DRAFTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_reply_drafts (
    user_id    TEXT NOT NULL,
    chat_id    TEXT NOT NULL,
    message_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    message    TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat_id, message_id)
  );
`;

// Fields a reply snapshot owns; one missing from the snapshot clears the saved value, as a direct save would.
const SNAPSHOT_FIELDS = ['content', 'agentId', 'pending', 'statusText', 'ptyPhase', 'userRequest'] as const;

/** The message a draft snapshot produces when applied to the saved one (mirrors updateChatMessage). */
export function applyReplySnapshot(existing: StoredMessage | undefined, snapshot: StoredMessage, version: number): StoredMessage {
  const next: StoredMessage = { ...existing, ...snapshot };
  for (const field of SNAPSHOT_FIELDS) if (!(field in snapshot)) delete next[field];
  next.version = version;
  next.serverManaged = true;
  next.ts = existing?.ts ?? snapshot.ts;
  next.parts = snapshot.parts ?? existing?.parts;
  if (!next.parts) delete next.parts;
  return next;
}

/** Saves the latest snapshot of a streaming reply. Returns false when the chat does not exist. */
export function saveReplyDraftWithDb(db: Database.Database, userId: string, chatId: string, snapshot: StoredMessage): boolean {
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM chats WHERE user_id = ? AND chat_id = ?').get(userId, chatId)) return false;
    db.prepare(`
      INSERT INTO chat_reply_drafts (user_id, chat_id, message_id, seq, message, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT (user_id, chat_id, message_id) DO UPDATE SET
        seq = seq + 1, message = excluded.message, updated_at = excluded.updated_at
    `).run(userId, chatId, snapshot.id, JSON.stringify(snapshot), Date.now());
    return true;
  })();
}

/**
 * Layers a chat's drafts over its saved messages. A draft's version counts up from the saved
 * message's, so readers see it increase with every snapshot and the final save goes above it.
 */
export function overlayReplyDrafts(db: Database.Database, userId: string, chatId: string, messages: StoredMessage[]): StoredMessage[] {
  const drafts = db.prepare('SELECT seq, message FROM chat_reply_drafts WHERE user_id = ? AND chat_id = ?')
    .all(userId, chatId) as { seq: number; message: string }[];
  if (!drafts.length) return messages;
  const next = [...messages];
  for (const draft of drafts) {
    const snapshot = JSON.parse(draft.message) as StoredMessage;
    const index = next.findIndex((message) => message.id === snapshot.id);
    const existing = index >= 0 ? next[index] : undefined;
    if (existing?.pending === false) continue; // the finished reply is authoritative
    const merged = applyReplySnapshot(existing, snapshot, (existing?.version || 0) + draft.seq);
    if (index < 0) next.push(merged);
    else next[index] = merged;
  }
  return next.sort((a, b) => a.ts - b.ts);
}

/** Drops drafts once their content is in the chat row (all of the chat's when `keepIds` is omitted). */
export function deleteReplyDraftsWithDb(db: Database.Database, userId: string, chatId: string, keepIds?: Set<string>): void {
  if (!keepIds) {
    db.prepare('DELETE FROM chat_reply_drafts WHERE user_id = ? AND chat_id = ?').run(userId, chatId);
    return;
  }
  const drafts = db.prepare('SELECT message_id FROM chat_reply_drafts WHERE user_id = ? AND chat_id = ?')
    .all(userId, chatId) as { message_id: string }[];
  for (const { message_id: messageId } of drafts) {
    if (!keepIds.has(messageId)) {
      db.prepare('DELETE FROM chat_reply_drafts WHERE user_id = ? AND chat_id = ? AND message_id = ?').run(userId, chatId, messageId);
    }
  }
}
