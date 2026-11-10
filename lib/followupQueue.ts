import { randomUUID } from 'crypto';
import { getDb } from './chatStore';

export const MAX_FOLLOWUPS_PER_CHAT = 20;
export const MAX_FOLLOWUP_TEXT_LENGTH = 20_000;

export type Followup = {
  id: string;
  chatId: string;
  agentId: string;
  text: string;
  modelId?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
};

type FollowupRow = {
  id: string; user_id: string; chat_id: string; agent_id: string; text: string;
  model_id: string | null; created_at: number; updated_at: number; version: number;
};

function toFollowup(row: FollowupRow): Followup {
  return {
    id: row.id, chatId: row.chat_id, agentId: row.agent_id, text: row.text,
    modelId: row.model_id || undefined, createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
  };
}

export function listFollowups(userId: string, chatId: string): Followup[] {
  return (getDb()
    .prepare('SELECT * FROM chat_followups WHERE user_id = ? AND chat_id = ? ORDER BY created_at, rowid')
    .all(userId, chatId) as FollowupRow[]).map(toFollowup);
}

export function countFollowupsByChat(userId: string): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT chat_id, COUNT(*) AS n FROM chat_followups WHERE user_id = ? GROUP BY chat_id')
    .all(userId) as { chat_id: string; n: number }[];
  return Object.fromEntries(rows.map(row => [row.chat_id, row.n]));
}

export type AddFollowupResult = { ok: true; item: Followup } | { ok: false; error: 'queue_full' | 'empty' | 'too_long' };

export function addFollowup(userId: string, input: { chatId: string; agentId: string; text: string; modelId?: string }): AddFollowupResult {
  const text = input.text.trim();
  if (!text) return { ok: false, error: 'empty' };
  if (text.length > MAX_FOLLOWUP_TEXT_LENGTH) return { ok: false, error: 'too_long' };
  const db = getDb();
  return db.transaction((): AddFollowupResult => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM chat_followups WHERE user_id = ? AND chat_id = ?')
      .get(userId, input.chatId) as { n: number };
    if (n >= MAX_FOLLOWUPS_PER_CHAT) return { ok: false, error: 'queue_full' };
    const now = Date.now();
    const row: FollowupRow = {
      id: randomUUID(), user_id: userId, chat_id: input.chatId, agent_id: input.agentId, text,
      model_id: input.modelId || null, created_at: now, updated_at: now, version: 1,
    };
    db.prepare(`INSERT INTO chat_followups (id, user_id, chat_id, agent_id, text, model_id, created_at, updated_at, version)
      VALUES (@id, @user_id, @chat_id, @agent_id, @text, @model_id, @created_at, @updated_at, @version)`).run(row);
    return { ok: true, item: toFollowup(row) };
  })();
}

export type UpdateFollowupResult = { ok: true; item: Followup } | { ok: false; error: 'missing' | 'conflict' | 'empty' | 'too_long' };

/** Optimistic update: fails with `conflict` when another device edited the item first. */
export function updateFollowup(userId: string, id: string, text: string, version: number): UpdateFollowupResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'empty' };
  if (trimmed.length > MAX_FOLLOWUP_TEXT_LENGTH) return { ok: false, error: 'too_long' };
  const db = getDb();
  const changed = db.prepare('UPDATE chat_followups SET text = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND id = ? AND version = ?')
    .run(trimmed, Date.now(), userId, id, version).changes;
  const row = db.prepare('SELECT * FROM chat_followups WHERE user_id = ? AND id = ?').get(userId, id) as FollowupRow | undefined;
  if (!row) return { ok: false, error: 'missing' };
  return changed ? { ok: true, item: toFollowup(row) } : { ok: false, error: 'conflict' };
}

export function removeFollowup(userId: string, id: string): boolean {
  return getDb().prepare('DELETE FROM chat_followups WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

/** Atomically removes and returns every queued item of a chat for one agent. */
export function takeFollowups(userId: string, chatId: string, agentId: string): Followup[] {
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare('SELECT * FROM chat_followups WHERE user_id = ? AND chat_id = ? AND agent_id = ? ORDER BY created_at, rowid')
      .all(userId, chatId, agentId) as FollowupRow[];
    db.prepare('DELETE FROM chat_followups WHERE user_id = ? AND chat_id = ? AND agent_id = ?').run(userId, chatId, agentId);
    return rows.map(toFollowup);
  })();
}

/** Puts taken items back (e.g. when dispatch failed), keeping their original order. */
export function restoreFollowups(userId: string, items: Followup[]): void {
  const db = getDb();
  const insert = db.prepare(`INSERT OR IGNORE INTO chat_followups (id, user_id, chat_id, agent_id, text, model_id, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const item of items) {
      insert.run(item.id, userId, item.chatId, item.agentId, item.text, item.modelId || null, item.createdAt, item.updatedAt, item.version);
    }
  })();
}

/** Builds the single prompt sent to the agent for all queued items. */
export function combineFollowups(items: Pick<Followup, 'text'>[]): string {
  const texts = items.map(item => item.text.trim()).filter(Boolean);
  if (texts.length <= 1) return texts[0] || '';
  return `Follow-ups queued while you were working:\n\n${texts.map((text, index) => `${index + 1}. ${text}`).join('\n\n')}`;
}
