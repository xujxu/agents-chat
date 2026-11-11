import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { createLogger } from '@/lib/logger';
import { setDbRoleLookup, setGitHubBindingLookup } from '@/lib/auth';

const logger = createLogger('configStore');

/**
 * Server-side config storage for agents and nodes — SQLite backend.
 * Single file: .data/config.db
 */

const DATA_DIR = path.join(process.cwd(), '.data');
const DB_PATH = path.join(DATA_DIR, 'config.db');
const AGENTS_JSON_PATH = path.join(process.cwd(), 'agents.json');
const NODES_JSON_PATH = path.join(process.cwd(), 'nodes.json');

// ─── Types ───

export type AgentModel = {
  modelId: string;
  name?: string;
  description?: string;
};

export type AgentRecord = {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  yolo: boolean;
  noTools: boolean;
  relay: boolean;
  relayConnectionName: string;
  public: boolean;
  models: AgentModel[];
  defaultModelId: string;
  env: Record<string, string>;
  owner: string;
  createdAt: string;
  updatedAt: string;
};

export type NodeRecord = {
  name: string;
  label: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
};

// ─── DB Initialization ───

let _db: ReturnType<typeof Database> | null = null;

function getDb(): ReturnType<typeof Database> {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      key TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT 'copilot.exe',
      args TEXT NOT NULL DEFAULT '[]',
      cwd TEXT NOT NULL DEFAULT '',
      yolo INTEGER NOT NULL DEFAULT 1,
      no_tools INTEGER NOT NULL DEFAULT 0,
      relay INTEGER NOT NULL DEFAULT 0,
      relay_connection_name TEXT NOT NULL DEFAULT '',
      public INTEGER NOT NULL DEFAULT 0,
      models TEXT NOT NULL DEFAULT '[]',
      default_model_id TEXT NOT NULL DEFAULT '',
      env TEXT NOT NULL DEFAULT '{}',
      owner TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS nodes (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_access (
      agent_id TEXT NOT NULL,
      email TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL DEFAULT (datetime('now', '+30 days')),
      accepted_at TEXT,
      extension_days INTEGER,
      extension_requested_at TEXT,
      expiry_reminded_for TEXT,
      extension_notified_for TEXT,
      PRIMARY KEY (agent_id, email),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS teams_conversations (
      email TEXT PRIMARY KEY,
      service_url TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      bot_name TEXT,
      user_id TEXT NOT NULL,
      user_name TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_share_links (
      agent_id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      granted_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS github_identity_bindings (
      email TEXT PRIMARY KEY,
      github_id TEXT NOT NULL,
      github_login TEXT NOT NULL DEFAULT '',
      bound_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_github_identity_bindings_id ON github_identity_bindings(github_id);
    CREATE TABLE IF NOT EXISTS user_agent_model_prefs (
      user_email TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      model_id   TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_email, agent_id)
    );
    CREATE TABLE IF NOT EXISTS user_last_used_agent (
      user_email TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_chat_last_used_agent (
      user_email TEXT NOT NULL,
      chat_id    TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_email, chat_id)
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_email TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_email, key)
    );
  `);
  runMigrations();
  return _db;
}

// ─── Migration from JSON files ───

function runMigrations(): void {
  const db = _db!;

  // Migrate agents.json
  const agentsMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('agents_json_import');
  if (!agentsMigrated) {
    try {
      const raw = fs.readFileSync(AGENTS_JSON_PATH, 'utf-8');
      const data = JSON.parse(raw);
      const agents = (data.agents || []) as any[];
      const defaultOwner = getDefaultOwner();

      const insert = db.prepare(`
        INSERT OR IGNORE INTO agents (id, name, command, args, cwd, yolo, no_tools, relay, relay_connection_name, public, models, default_model_id, env, owner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const tx = db.transaction(() => {
        for (const a of agents) {
          const models = normalizeAgentModels(a.models);
          insert.run(
            a.id,
            a.name || a.id,
            a.command || 'copilot.exe',
            JSON.stringify(a.args || []),
            a.cwd || '',
            a.yolo ? 1 : 0,
            a.noTools ? 1 : 0,
            a.relay ? 1 : 0,
            a.relayConnectionName || '',
            a.id === 'copilot' ? 1 : 0,
            JSON.stringify(models),
            normalizeDefaultModelId(a.defaultModelId, models),
            JSON.stringify(a.env || {}),
            defaultOwner,
          );
        }
        db.prepare('INSERT INTO migrations (key) VALUES (?)').run('agents_json_import');
      });
      tx();
      logger.info({ count: agents.length, owner: defaultOwner }, `[ConfigStore] Migrated ${agents.length} agents from agents.json (owner=${defaultOwner})`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') logger.error({ err }, '[ConfigStore] agents.json migration error');
      // Mark as done even if file doesn't exist
      db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('agents_json_import');
    }
  }

  // Migrate nodes.json
  const nodesMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('nodes_json_import');
  if (!nodesMigrated) {
    try {
      const raw = fs.readFileSync(NODES_JSON_PATH, 'utf-8');
      const data = JSON.parse(raw);
      const nodes = (data.nodes || []) as any[];
      const defaultOwner = getDefaultOwner();

      const insert = db.prepare(`
        INSERT OR IGNORE INTO nodes (name, label, owner) VALUES (?, ?, ?)
      `);

      const tx = db.transaction(() => {
        for (const n of nodes) {
          insert.run(n.name, n.label || n.name, defaultOwner);
        }
        db.prepare('INSERT INTO migrations (key) VALUES (?)').run('nodes_json_import');
      });
      tx();
      logger.info({ count: nodes.length, owner: defaultOwner }, `[ConfigStore] Migrated ${nodes.length} nodes from nodes.json (owner=${defaultOwner})`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') logger.error({ err }, '[ConfigStore] nodes.json migration error');
      db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('nodes_json_import');
    }
  }

  // Add 'public' column if missing (for existing databases created before this feature)
  const publicColMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('add_public_column');
  if (!publicColMigrated) {
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN public INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists if DB was created fresh with the new schema
    }
    // Set copilot as public by default
    db.prepare("UPDATE agents SET public = 1 WHERE id = 'copilot'").run();
    db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('add_public_column');
  }

  const modelColsMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('add_agent_model_columns');
  if (!modelColsMigrated) {
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN models TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      // Column already exists if DB was created fresh with the new schema
    }
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN default_model_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists if DB was created fresh with the new schema
    }
    db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('add_agent_model_columns');
  }

  const envColMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('add_env_column');
  if (!envColMigrated) {
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN env TEXT NOT NULL DEFAULT '{}'`);
    } catch {
      // Column already exists if DB was created fresh with the new schema
    }
    db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('add_env_column');
  }

  // Share links: grants now expire and only count once the recipient opens the agent's share link. Grants
  // made before this keep working (accepted) and get a fresh expiry.
  const sharingMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('agent_access_sharing');
  if (!sharingMigrated) {
    for (const column of ['expires_at TEXT', 'accepted_at TEXT', 'extension_days INTEGER', 'extension_requested_at TEXT']) {
      try {
        db.exec(`ALTER TABLE agent_access ADD COLUMN ${column}`);
      } catch {
        // Column already exists if DB was created fresh with the new schema
      }
    }
    db.prepare(`UPDATE agent_access SET accepted_at = COALESCE(accepted_at, created_at),
      expires_at = COALESCE(expires_at, datetime('now', '+${SHARE_DAYS} days'))`).run();
    db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('agent_access_sharing');
  }

  // Teams reminders: remember which expiry and which extension request were already announced in Teams.
  const remindersMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('agent_access_teams_reminders');
  if (!remindersMigrated) {
    for (const column of ['expiry_reminded_for TEXT', 'extension_notified_for TEXT']) {
      try {
        db.exec(`ALTER TABLE agent_access ADD COLUMN ${column}`);
      } catch {
        // Column already exists if DB was created fresh with the new schema
      }
    }
    db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('agent_access_teams_reminders');
  }
}

function normalizeAgentModels(input: unknown): AgentModel[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const models: AgentModel[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    models.push({
      modelId,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    });
  }
  return models;
}

function parseAgentModels(raw: unknown): AgentModel[] {
  if (Array.isArray(raw)) return normalizeAgentModels(raw);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    return normalizeAgentModels(JSON.parse(raw));
  } catch {
    return [];
  }
}

function normalizeDefaultModelId(input: unknown, models: AgentModel[]): string {
  const modelId = typeof input === 'string' ? input.trim() : '';
  if (!modelId) return '';
  if (models.length > 0 && !models.some(model => model.modelId === modelId)) return '';
  return modelId;
}

function getDefaultOwner(): string {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails[0] || 'system';
}

function parseEnv(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

// ─── Agent CRUD ───

function rowToAgent(row: any): AgentRecord {
  const models = parseAgentModels(row.models);
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: JSON.parse(row.args || '[]'),
    cwd: row.cwd,
    yolo: !!row.yolo,
    noTools: !!row.no_tools,
    relay: !!row.relay,
    relayConnectionName: row.relay_connection_name,
    public: !!row.public,
    models,
    defaultModelId: normalizeDefaultModelId(row.default_model_id, models),
    env: parseEnv(row.env),
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllAgents(): AgentRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all();
  return rows.map(rowToAgent);
}

export function getAgentById(agentId: string): AgentRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as any;
  return row ? rowToAgent(row) : null;
}

export function createAgent(agent: {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  yolo?: boolean;
  noTools?: boolean;
  relay?: boolean;
  relayConnectionName?: string;
  public?: boolean;
  models?: AgentModel[];
  defaultModelId?: string;
  env?: Record<string, string>;
  owner: string;
}): AgentRecord {
  const db = getDb();
  const models = normalizeAgentModels(agent.models);
  const defaultModelId = normalizeDefaultModelId(agent.defaultModelId, models);
  db.prepare(`
    INSERT INTO agents (id, name, command, args, cwd, yolo, no_tools, relay, relay_connection_name, public, models, default_model_id, env, owner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id,
    agent.name || agent.id,
    agent.command || 'copilot.exe',
    JSON.stringify(agent.args || []),
    agent.cwd || '',
    agent.yolo !== false ? 1 : 0,
    agent.noTools ? 1 : 0,
    agent.relay ? 1 : 0,
    agent.relayConnectionName || '',
    agent.public ? 1 : 0,
    JSON.stringify(models),
    defaultModelId,
    JSON.stringify(agent.env || {}),
    agent.owner,
  );
  return getAgentById(agent.id)!;
}

export function updateAgent(agentId: string, updates: Partial<{
  name: string;
  command: string;
  args: string[];
  cwd: string;
  yolo: boolean;
  noTools: boolean;
  relay: boolean;
  relayConnectionName: string;
  public: boolean;
  env: Record<string, string>;
  models: AgentModel[];
  defaultModelId: string;
}>): AgentRecord | null {
  const db = getDb();
  const existing = getAgentById(agentId);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.command !== undefined) { fields.push('command = ?'); values.push(updates.command); }
  if (updates.args !== undefined) { fields.push('args = ?'); values.push(JSON.stringify(updates.args)); }
  if (updates.cwd !== undefined) { fields.push('cwd = ?'); values.push(updates.cwd); }
  if (updates.yolo !== undefined) { fields.push('yolo = ?'); values.push(updates.yolo ? 1 : 0); }
  if (updates.noTools !== undefined) { fields.push('no_tools = ?'); values.push(updates.noTools ? 1 : 0); }
  if (updates.relay !== undefined) { fields.push('relay = ?'); values.push(updates.relay ? 1 : 0); }
  if (updates.relayConnectionName !== undefined) { fields.push('relay_connection_name = ?'); values.push(updates.relayConnectionName); }
  if (updates.public !== undefined) { fields.push('public = ?'); values.push(updates.public ? 1 : 0); }
  if (updates.env !== undefined) { fields.push('env = ?'); values.push(JSON.stringify(updates.env)); }
  if (updates.models !== undefined) {
    const models = normalizeAgentModels(updates.models);
    fields.push('models = ?');
    values.push(JSON.stringify(models));
    if (updates.defaultModelId === undefined) {
      fields.push('default_model_id = ?');
      values.push(normalizeDefaultModelId(existing.defaultModelId, models));
    }
  }
  if (updates.defaultModelId !== undefined) {
    const models = updates.models !== undefined ? normalizeAgentModels(updates.models) : existing.models;
    fields.push('default_model_id = ?');
    values.push(normalizeDefaultModelId(updates.defaultModelId, models));
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = datetime('now')");
  values.push(agentId);

  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getAgentById(agentId);
}

export function deleteAgent(agentId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  return result.changes > 0;
}

// ─── Node CRUD ───

function rowToNode(row: any): NodeRecord {
  return {
    name: row.name,
    label: row.label || row.name,
    owner: row.owner || 'system',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllNodes(): NodeRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM nodes ORDER BY created_at ASC').all();
  return rows.map(rowToNode);
}

export function getNodeByName(name: string): NodeRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM nodes WHERE name = ?').get(name) as any;
  return row ? rowToNode(row) : null;
}

export function createNode(node: { name: string; label?: string; owner: string }): NodeRecord {
  const db = getDb();
  db.prepare('INSERT INTO nodes (name, label, owner) VALUES (?, ?, ?)').run(
    node.name,
    node.label || node.name,
    node.owner,
  );
  return getNodeByName(node.name)!;
}

export function updateNode(name: string, updates: { label?: string; owner?: string }): NodeRecord | null {
  const db = getDb();
  const existing = getNodeByName(name);
  if (!existing) return null;

  if (updates.label !== undefined) {
    db.prepare("UPDATE nodes SET label = ?, updated_at = datetime('now') WHERE name = ?").run(updates.label, name);
  }
  if (updates.owner !== undefined) {
    db.prepare("UPDATE nodes SET owner = ?, updated_at = datetime('now') WHERE name = ?").run(updates.owner, name);
  }
  return getNodeByName(name);
}

export function deleteNode(name: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM nodes WHERE name = ?').run(name);
  return result.changes > 0;
}

// ─── Agent Access Control ───
//
// A grant (agent_access row) is an invite until the recipient opens the agent's share link while signed in
// as the invited account; then it is active until it expires. Expired grants still let the recipient sign
// in for EXPIRED_GRACE_DAYS so they can ask for more time; after that they are ignored.

export const SHARE_DAYS = 30;
export const EXPIRED_GRACE_DAYS = 30;
export const MAX_EXTENSION_DAYS = 90;
/** Days before expiry when recipients are reminded (in the app and in Teams) and may ask for more time. */
export const SHARE_REMIND_DAYS = 3;

export type AgentAccessStatus = 'pending' | 'active' | 'expired';
export type AgentAccessEntry = {
  email: string;
  grantedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  status: AgentAccessStatus;
  extensionDays: number | null;
  extensionRequestedAt: string | null;
};

/** SQLite `datetime()` text (UTC, no zone) as ISO-8601. */
function sqliteTimeToIso(value: string | null): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
}

function accessColumns(t = ''): string {
  return `${t}email AS email, ${t}granted_by AS granted_by, ${t}created_at AS created_at, ${t}expires_at AS expires_at,
    ${t}accepted_at AS accepted_at, ${t}extension_days AS extension_days, ${t}extension_requested_at AS extension_requested_at,
    CASE WHEN ${t}expires_at <= datetime('now') THEN 'expired' WHEN ${t}accepted_at IS NULL THEN 'pending' ELSE 'active' END AS status`;
}

function toAccessEntry(r: any): AgentAccessEntry {
  return {
    email: r.email,
    grantedBy: r.granted_by,
    createdAt: sqliteTimeToIso(r.created_at) || '',
    expiresAt: sqliteTimeToIso(r.expires_at) || '',
    acceptedAt: sqliteTimeToIso(r.accepted_at),
    status: r.status,
    extensionDays: r.extension_days ?? null,
    extensionRequestedAt: sqliteTimeToIso(r.extension_requested_at),
  };
}

/** Invites `email` (or renews an existing grant) for SHARE_DAYS. Recipients still need the share link. */
export function addAgentAccess(agentId: string, email: string, grantedBy: string): boolean {
  const db = getDb();
  try {
    db.prepare(`INSERT INTO agent_access (agent_id, email, granted_by, expires_at) VALUES (?, ?, ?, datetime('now', '+${SHARE_DAYS} days'))
      ON CONFLICT(agent_id, email) DO UPDATE SET granted_by = excluded.granted_by,
        expires_at = MAX(agent_access.expires_at, excluded.expires_at)`).run(
      agentId, email.toLowerCase(), grantedBy.toLowerCase(),
    );
    return true;
  } catch {
    return false;
  }
}

export function removeAgentAccess(agentId: string, email: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM agent_access WHERE agent_id = ? AND email = ?').run(agentId, email.toLowerCase());
  return result.changes > 0;
}

export function getAgentAccessList(agentId: string): AgentAccessEntry[] {
  const db = getDb();
  const rows = db.prepare(`SELECT ${accessColumns()} FROM agent_access WHERE agent_id = ? ORDER BY created_at ASC`).all(agentId) as any[];
  return rows.map(toAccessEntry);
}

export function getAgentAccess(agentId: string, email: string): AgentAccessEntry | null {
  const db = getDb();
  const row = db.prepare(`SELECT ${accessColumns()} FROM agent_access WHERE agent_id = ? AND email = ?`).get(agentId, email.toLowerCase());
  return row ? toAccessEntry(row) : null;
}

/** Whether `email` may use the agent through a grant: accepted through the share link and not expired. */
export function hasAgentAccess(agentId: string, email: string): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT 1 FROM agent_access WHERE agent_id = ? AND email = ?
    AND accepted_at IS NOT NULL AND expires_at > datetime('now')`).get(agentId, email.toLowerCase());
  return !!row;
}

/** Whether a grant lets `email` sign in as a guest: invited, active, or recently expired. */
export function hasAnyAgentAccess(email: string): boolean {
  const db = getDb();
  return !!db.prepare(`SELECT 1 FROM agent_access WHERE email = ?
    AND expires_at > datetime('now', '-${EXPIRED_GRACE_DAYS} days') LIMIT 1`).get(email.toLowerCase());
}

/** Every agent access grant, for the admin "Users & roles" view. */
export function listAllAgentAccess(): { agentId: string; email: string; grantedBy: string; createdAt: string }[] {
  const db = getDb();
  const rows = db.prepare('SELECT agent_id, email, granted_by, created_at FROM agent_access ORDER BY email, agent_id').all() as any[];
  return rows.map(r => ({ agentId: r.agent_id, email: r.email, grantedBy: r.granted_by, createdAt: r.created_at }));
}

/** Activates an unexpired grant (idempotent). False when `email` has no unexpired grant for the agent. */
export function acceptAgentInvite(agentId: string, email: string): boolean {
  const db = getDb();
  const result = db.prepare(`UPDATE agent_access SET accepted_at = COALESCE(accepted_at, datetime('now'))
    WHERE agent_id = ? AND email = ? AND expires_at > datetime('now')`).run(agentId, email.toLowerCase());
  return result.changes > 0;
}

/** Grants that still let `email` sign in, with agent names, for the recipient's own notices. */
export function listUserAgentGrants(email: string): (AgentAccessEntry & { agentId: string; agentName: string })[] {
  const db = getDb();
  const rows = db.prepare(`SELECT a.agent_id, COALESCE(ag.name, a.agent_id) AS agent_name, ${accessColumns('a.')}
    FROM agent_access a LEFT JOIN agents ag ON ag.id = a.agent_id
    WHERE a.email = ? AND a.expires_at > datetime('now', '-${EXPIRED_GRACE_DAYS} days') ORDER BY a.expires_at`).all(email.toLowerCase()) as any[];
  return rows.map(r => ({ ...toAccessEntry(r), agentId: r.agent_id, agentName: r.agent_name }));
}

/** Records the recipient's request for `days` more days on an accepted grant (replacing any earlier request). */
export function requestAgentAccessExtension(agentId: string, email: string, days: number): boolean {
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXTENSION_DAYS) return false;
  const db = getDb();
  // Reset the Teams notice marker: timestamps have 1 s precision, so a new request in the same
  // second as an earlier, already-notified one would otherwise look notified too.
  const result = db.prepare(`UPDATE agent_access SET extension_days = ?, extension_requested_at = datetime('now'),
    extension_notified_for = NULL
    WHERE agent_id = ? AND email = ? AND accepted_at IS NOT NULL
      AND expires_at > datetime('now', '-${EXPIRED_GRACE_DAYS} days')`).run(days, agentId, email.toLowerCase());
  return result.changes > 0;
}

/** Pending extension requests across all agents, for admins. */
export function listAgentAccessExtensionRequests(): (AgentAccessEntry & { agentId: string; agentName: string })[] {
  const db = getDb();
  const rows = db.prepare(`SELECT a.agent_id, COALESCE(ag.name, a.agent_id) AS agent_name, ${accessColumns('a.')}
    FROM agent_access a LEFT JOIN agents ag ON ag.id = a.agent_id
    WHERE a.extension_requested_at IS NOT NULL ORDER BY a.extension_requested_at`).all() as any[];
  return rows.map(r => ({ ...toAccessEntry(r), agentId: r.agent_id, agentName: r.agent_name }));
}

/** Extends a grant by `days` from its expiry, or from now if it already expired, and clears any request. */
export function extendAgentAccess(agentId: string, email: string, days: number): boolean {
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXTENSION_DAYS) return false;
  const db = getDb();
  const result = db.prepare(`UPDATE agent_access SET expires_at = datetime(MAX(expires_at, datetime('now')), ?),
    extension_days = NULL, extension_requested_at = NULL WHERE agent_id = ? AND email = ?`).run(`+${days} days`, agentId, email.toLowerCase());
  return result.changes > 0;
}

export function denyAgentAccessExtension(agentId: string, email: string): boolean {
  const db = getDb();
  const result = db.prepare(`UPDATE agent_access SET extension_days = NULL, extension_requested_at = NULL
    WHERE agent_id = ? AND email = ? AND extension_requested_at IS NOT NULL`).run(agentId, email.toLowerCase());
  return result.changes > 0;
}

// ─── Teams reminders (sent only to people who have a 1:1 chat with the Teams bot) ───

export type GrantNotice = AgentAccessEntry & { agentId: string; agentName: string };

/** Active grants expiring within `remindDays` whose current expiry has not been announced in Teams yet. */
export function listGrantsDueForTeamsReminder(remindDays = SHARE_REMIND_DAYS): GrantNotice[] {
  const rows = getDb().prepare(`SELECT a.agent_id, COALESCE(ag.name, a.agent_id) AS agent_name, ${accessColumns('a.')}
    FROM agent_access a LEFT JOIN agents ag ON ag.id = a.agent_id
    WHERE a.accepted_at IS NOT NULL AND a.expires_at > datetime('now') AND a.expires_at <= datetime('now', ?)
      AND a.extension_requested_at IS NULL AND (a.expiry_reminded_for IS NULL OR a.expiry_reminded_for <> a.expires_at)
    ORDER BY a.expires_at`).all(`+${remindDays} days`) as any[];
  return rows.map(r => ({ ...toAccessEntry(r), agentId: r.agent_id, agentName: r.agent_name }));
}

/** Records the reminder for this expiry only, so an extension (a new expiry) is reminded again later. */
export function markTeamsExpiryReminded(agentId: string, email: string, expiresAt: string): boolean {
  const result = getDb().prepare(`UPDATE agent_access SET expiry_reminded_for = expires_at
    WHERE agent_id = ? AND email = ? AND expires_at = ?`).run(agentId, email.toLowerCase(), isoToSqliteTime(expiresAt));
  return result.changes > 0;
}

/** Extension requests that admins have not been told about in Teams yet. */
export function listExtensionRequestsDueForTeamsNotice(): GrantNotice[] {
  const rows = getDb().prepare(`SELECT a.agent_id, COALESCE(ag.name, a.agent_id) AS agent_name, ${accessColumns('a.')}
    FROM agent_access a LEFT JOIN agents ag ON ag.id = a.agent_id
    WHERE a.extension_requested_at IS NOT NULL
      AND (a.extension_notified_for IS NULL OR a.extension_notified_for <> a.extension_requested_at)
    ORDER BY a.extension_requested_at`).all() as any[];
  return rows.map(r => ({ ...toAccessEntry(r), agentId: r.agent_id, agentName: r.agent_name }));
}

export function markTeamsExtensionNotified(agentId: string, email: string, requestedAt: string): boolean {
  const result = getDb().prepare(`UPDATE agent_access SET extension_notified_for = extension_requested_at
    WHERE agent_id = ? AND email = ? AND extension_requested_at = ?`).run(agentId, email.toLowerCase(), isoToSqliteTime(requestedAt));
  return result.changes > 0;
}

/** ISO-8601 from `sqliteTimeToIso` back to SQLite `datetime()` text. */
function isoToSqliteTime(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ? value.slice(0, 19).replace('T', ' ') : value;
}

/** Where to reach a person proactively: their latest 1:1 chat with the Teams bot. */
export type TeamsConversation = {
  serviceUrl: string;
  conversationId: string;
  botId: string;
  botName?: string;
  userId: string;
  userName?: string;
};

export function saveTeamsConversation(email: string, ref: TeamsConversation): void {
  getDb().prepare(`INSERT INTO teams_conversations (email, service_url, conversation_id, bot_id, bot_name, user_id, user_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET service_url = excluded.service_url, conversation_id = excluded.conversation_id,
      bot_id = excluded.bot_id, bot_name = excluded.bot_name, user_id = excluded.user_id, user_name = excluded.user_name,
      updated_at = datetime('now')`).run(
    email.toLowerCase(), ref.serviceUrl, ref.conversationId, ref.botId, ref.botName ?? null, ref.userId, ref.userName ?? null,
  );
}

export function getTeamsConversation(email: string): TeamsConversation | null {
  const row = getDb().prepare('SELECT * FROM teams_conversations WHERE email = ?').get(email.toLowerCase()) as any;
  if (!row) return null;
  return {
    serviceUrl: row.service_url,
    conversationId: row.conversation_id,
    botId: row.bot_id,
    botName: row.bot_name ?? undefined,
    userId: row.user_id,
    userName: row.user_name ?? undefined,
  };
}

/** Forgets a chat the bot can no longer post to (e.g. the person removed the app). */
export function removeTeamsConversation(email: string, conversationId: string): boolean {
  return getDb().prepare('DELETE FROM teams_conversations WHERE email = ? AND conversation_id = ?')
    .run(email.toLowerCase(), conversationId).changes > 0;
}

// ─── Agent share links (one per agent; the link alone grants nothing without a grant) ───

export function getAgentShareToken(agentId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT token FROM agent_share_links WHERE agent_id = ?').get(agentId) as { token: string } | undefined;
  return row?.token ?? null;
}

/** Creates the agent's share link, replacing (and so invalidating) any previous one. */
export function rotateAgentShareToken(agentId: string, createdBy: string): string {
  const db = getDb();
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO agent_share_links (agent_id, token, created_by) VALUES (?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET token = excluded.token, created_by = excluded.created_by, created_at = datetime('now')`).run(
    agentId, token, createdBy.toLowerCase(),
  );
  return token;
}

export function revokeAgentShareToken(agentId: string): boolean {
  const db = getDb();
  return db.prepare('DELETE FROM agent_share_links WHERE agent_id = ?').run(agentId).changes > 0;
}

export function getAgentIdByShareToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const db = getDb();
  const row = db.prepare('SELECT agent_id FROM agent_share_links WHERE token = ?').get(token) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}

// ─── Global User Roles (managed in the UI; env roles live in ADMIN_EMAILS / MEMBER_EMAILS) ───

export type DbUserRole = 'admin' | 'member';
export type UserRoleRecord = { email: string; role: DbUserRole; grantedBy: string; createdAt: string; updatedAt: string };

export function listUserRoles(): UserRoleRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT email, role, granted_by, created_at, updated_at FROM user_roles ORDER BY email').all() as any[];
  return rows.map(r => ({ email: r.email, role: r.role, grantedBy: r.granted_by, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export function getDbUserRole(email: string): DbUserRole | null {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) return null;
  const row = getDb().prepare('SELECT role FROM user_roles WHERE email = ?').get(normalized) as { role: DbUserRole } | undefined;
  return row?.role ?? null;
}

export function setUserRole(email: string, role: DbUserRole, grantedBy: string): void {
  getDb().prepare(`
    INSERT INTO user_roles (email, role, granted_by) VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, updated_at = datetime('now')
  `).run(email.trim().toLowerCase(), role, grantedBy.toLowerCase());
}

export function removeUserRole(email: string): boolean {
  return getDb().prepare('DELETE FROM user_roles WHERE email = ?').run(email.trim().toLowerCase()).changes > 0;
}

setDbRoleLookup(getDbUserRole);

// ─── GitHub identity bindings (an allowed email is linked to the GitHub account that first signs in with it) ───

export type GitHubBinding = { email: string; githubId: string; githubLogin: string; boundAt: string };

function toGitHubBinding(r: any): GitHubBinding {
  return { email: r.email, githubId: r.github_id, githubLogin: r.github_login, boundAt: r.bound_at };
}

export function listGitHubBindings(): GitHubBinding[] {
  return (getDb().prepare('SELECT email, github_id, github_login, bound_at FROM github_identity_bindings ORDER BY email').all() as any[]).map(toGitHubBinding);
}

export function getGitHubBindingsForId(githubId: string): GitHubBinding[] {
  return (getDb().prepare('SELECT email, github_id, github_login, bound_at FROM github_identity_bindings WHERE github_id = ? ORDER BY bound_at, email').all(githubId) as any[]).map(toGitHubBinding);
}

export function getGitHubBindingId(email: string): string | null {
  const row = getDb().prepare('SELECT github_id FROM github_identity_bindings WHERE email = ?').get(email.trim().toLowerCase()) as { github_id: string } | undefined;
  return row?.github_id ?? null;
}

/** Links the email to the account unless another account already holds it; true when the account holds it. */
export function bindGitHubEmail(email: string, githubId: string, githubLogin: string): boolean {
  const normalized = email.trim().toLowerCase();
  const db = getDb();
  db.prepare('INSERT INTO github_identity_bindings (email, github_id, github_login) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .run(normalized, githubId, githubLogin);
  if (getGitHubBindingId(normalized) !== githubId) return false;
  db.prepare('UPDATE github_identity_bindings SET github_login = ? WHERE github_id = ?').run(githubLogin, githubId);
  return true;
}

export function removeGitHubBinding(email: string): boolean {
  return getDb().prepare('DELETE FROM github_identity_bindings WHERE email = ?').run(email.trim().toLowerCase()).changes > 0;
}

setGitHubBindingLookup(getGitHubBindingId);

// ─── User Agent Model Preferences ───

export function getUserAgentModelPref(userEmail: string, agentId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT model_id FROM user_agent_model_prefs WHERE user_email = ? AND agent_id = ?')
    .get(userEmail.toLowerCase(), agentId) as any;
  return row?.model_id || null;
}

export function getUserAgentModelPrefs(userEmail: string): Record<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT agent_id, model_id FROM user_agent_model_prefs WHERE user_email = ?')
    .all(userEmail.toLowerCase()) as any[];
  const result: Record<string, string> = {};
  for (const row of rows) result[row.agent_id] = row.model_id;
  return result;
}

export function setUserAgentModelPref(userEmail: string, agentId: string, modelId: string): void {
  const db = getDb();
  if (!modelId) {
    db.prepare('DELETE FROM user_agent_model_prefs WHERE user_email = ? AND agent_id = ?')
      .run(userEmail.toLowerCase(), agentId);
  } else {
    db.prepare(`
      INSERT INTO user_agent_model_prefs (user_email, agent_id, model_id, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_email, agent_id) DO UPDATE SET model_id = excluded.model_id, updated_at = excluded.updated_at
    `).run(userEmail.toLowerCase(), agentId, modelId);
  }
}

// ─── User Last-Used Agent ───
//
// One row per user that records the agent they most recently @-mentioned.
// Used to pre-fill the composer target when opening any chat, replacing the
// per-chat browser-local "remembered agent" hint.

export function getUserLastUsedAgent(userEmail: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT agent_id FROM user_last_used_agent WHERE user_email = ?')
    .get(userEmail.toLowerCase()) as any;
  return row?.agent_id || null;
}

export function setUserLastUsedAgent(userEmail: string, agentId: string): void {
  const db = getDb();
  if (!agentId) {
    db.prepare('DELETE FROM user_last_used_agent WHERE user_email = ?').run(userEmail.toLowerCase());
    return;
  }
  db.prepare(`
    INSERT INTO user_last_used_agent (user_email, agent_id, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_email) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at
  `).run(userEmail.toLowerCase(), agentId);
}

// ─── User Per-Chat Last-Used Agent ───
//
// One row per (user, chat) when the user enables per-chat scope for the
// "last used agent" preference. Independent from the per-user row above —
// the active table is chosen at request time by the client based on the
// user's lastUsedAgentScope setting.

export function getUserChatLastUsedAgent(userEmail: string, chatId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT agent_id FROM user_chat_last_used_agent WHERE user_email = ? AND chat_id = ?')
    .get(userEmail.toLowerCase(), chatId) as any;
  return row?.agent_id || null;
}

export function getUserChatLastUsedAgents(userEmail: string): Record<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT chat_id, agent_id FROM user_chat_last_used_agent WHERE user_email = ?')
    .all(userEmail.toLowerCase()) as any[];
  const result: Record<string, string> = {};
  for (const row of rows) result[row.chat_id] = row.agent_id;
  return result;
}

export function setUserChatLastUsedAgent(userEmail: string, chatId: string, agentId: string): void {
  const db = getDb();
  if (!agentId) {
    db.prepare('DELETE FROM user_chat_last_used_agent WHERE user_email = ? AND chat_id = ?')
      .run(userEmail.toLowerCase(), chatId);
    return;
  }
  db.prepare(`
    INSERT INTO user_chat_last_used_agent (user_email, chat_id, agent_id, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_email, chat_id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at
  `).run(userEmail.toLowerCase(), chatId, agentId);
}

// ─── User Settings (generic key/value) ───

export function getUserSettings(userEmail: string): Record<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_email = ?')
    .all(userEmail.toLowerCase()) as any[];
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function setUserSetting(userEmail: string, key: string, value: string): void {
  const db = getDb();
  if (!value) {
    db.prepare('DELETE FROM user_settings WHERE user_email = ? AND key = ?')
      .run(userEmail.toLowerCase(), key);
    return;
  }
  db.prepare(`
    INSERT INTO user_settings (user_email, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_email, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userEmail.toLowerCase(), key, value);
}

/** User setting holding the agent a person starts with (web new chats, Teams), set when they accept a share link. */
export const DEFAULT_AGENT_SETTING = 'default_agent';

export function getUserDefaultAgent(userEmail: string): string | null {
  return getUserSettings(userEmail)[DEFAULT_AGENT_SETTING] || null;
}

/** User setting holding the default agent the person chose in Teams with `/default` (or the switch prompt). */
export const TEAMS_DEFAULT_AGENT_SETTING = 'teams_default_agent';
/** User setting holding the shared agent the person was last asked about switching to in Teams. */
export const TEAMS_SWITCH_ASKED_SETTING = 'teams_switch_asked';
