export const databaseProfile = 'agents-chat-638c553';

// Fixed historical schema, not SQL supplied by the target checkout.
export const databaseGroups = Object.freeze({
  'chats.db': [
    ['chats', 'chat_tombstones', 'shares', 'user_prefs', 'file_comments',
      'file_comment_replies', 'user_workflows', 'orchestrations', 'orchestration_nodes'],
    ['chat_operations'],
    ['chat_transfers', 'chat_transfer_chunks'],
    ['cron_jobs', 'cron_runs'],
  ],
  'config.db': [['migrations', 'agents', 'nodes', 'agent_access', 'user_agent_model_prefs',
    'user_last_used_agent', 'user_chat_last_used_agent', 'user_settings']],
});

export const migrationKeys = Object.freeze([
  'add_agent_model_columns', 'add_env_column', 'add_public_column', 'agents_json_import', 'nodes_json_import',
]);

export const referenceSchema = `
CREATE TABLE chats (
  user_id TEXT NOT NULL, chat_id TEXT NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]', agent_sessions TEXT NOT NULL DEFAULT '{}',
  git_context TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (user_id, chat_id)
);
ALTER TABLE chats ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_chats_user_ts ON chats (user_id, ts DESC);
CREATE TABLE chat_tombstones (
  user_id TEXT NOT NULL, chat_id TEXT NOT NULL, deleted_at INTEGER NOT NULL, PRIMARY KEY (user_id, chat_id)
);
CREATE TABLE shares (
  share_id TEXT PRIMARY KEY, shared_by TEXT NOT NULL, shared_at INTEGER NOT NULL,
  name TEXT NOT NULL, messages TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE user_prefs (
  user_id TEXT PRIMARY KEY, last_chat_id TEXT, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE file_comments (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, file_path TEXT NOT NULL,
  range_start_line INTEGER, range_end_line INTEGER, range_start_char INTEGER, range_end_char INTEGER,
  content TEXT NOT NULL, author_type TEXT NOT NULL, author_name TEXT,
  status TEXT NOT NULL DEFAULT 'active', linked_chat_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_file_comments_agent_file ON file_comments(agent_id, file_path);
CREATE INDEX idx_file_comments_linked_chat_status ON file_comments(linked_chat_id, status);
CREATE TABLE file_comment_replies (
  id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES file_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL, author_type TEXT NOT NULL, author_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_file_comment_replies_comment ON file_comment_replies(comment_id);
CREATE TABLE user_workflows (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, plan_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_user_workflows_user_updated ON user_workflows(user_id, updated_at DESC);
CREATE TABLE orchestrations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, mode TEXT NOT NULL,
  plan_json TEXT NOT NULL, summary_started INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_orchestrations_user_chat ON orchestrations(user_id, chat_id);
CREATE TABLE orchestration_nodes (
  orchestration_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, result TEXT,
  updated_at INTEGER NOT NULL, PRIMARY KEY (orchestration_id, node_id),
  FOREIGN KEY (orchestration_id) REFERENCES orchestrations(id) ON DELETE CASCADE
);
CREATE INDEX idx_orchestration_nodes_orch ON orchestration_nodes(orchestration_id);
CREATE TABLE chat_operations (
  user_id TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (user_id, operation_id)
);
CREATE TABLE chat_transfers (
  user_id TEXT NOT NULL, id TEXT NOT NULL, chat_id TEXT NOT NULL, purpose TEXT NOT NULL,
  total INTEGER NOT NULL, bytes INTEGER NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE chat_transfer_chunks (
  user_id TEXT NOT NULL, transfer_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (user_id, transfer_id, chunk_index),
  FOREIGN KEY (user_id, transfer_id) REFERENCES chat_transfers(user_id, id) ON DELETE CASCADE
);
CREATE TABLE cron_jobs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, owner_email TEXT NOT NULL, name TEXT NOT NULL,
  prompt TEXT NOT NULL, schedule_spec TEXT NOT NULL, cron_expr TEXT NOT NULL, enabled INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_run_at INTEGER, next_run_at INTEGER
);
ALTER TABLE cron_jobs ADD COLUMN timeout_minutes INTEGER;
CREATE TABLE cron_runs (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, scheduled_for INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER, status TEXT NOT NULL, reply_text TEXT,
  error_message TEXT, raw_log_path TEXT,
  FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
);
CREATE INDEX idx_cron_runs_job_sched ON cron_runs(job_id, scheduled_for DESC);
CREATE TABLE migrations (
  key TEXT PRIMARY KEY, completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL DEFAULT 'copilot.exe',
  args TEXT NOT NULL DEFAULT '[]', cwd TEXT NOT NULL DEFAULT '', yolo INTEGER NOT NULL DEFAULT 1,
  no_tools INTEGER NOT NULL DEFAULT 0, relay INTEGER NOT NULL DEFAULT 0,
  relay_connection_name TEXT NOT NULL DEFAULT '', public INTEGER NOT NULL DEFAULT 0,
  models TEXT NOT NULL DEFAULT '[]', default_model_id TEXT NOT NULL DEFAULT '',
  env TEXT NOT NULL DEFAULT '{}', owner TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE nodes (
  name TEXT PRIMARY KEY, label TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE agent_access (
  agent_id TEXT NOT NULL, email TEXT NOT NULL, granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (agent_id, email),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE TABLE user_agent_model_prefs (
  user_email TEXT NOT NULL, agent_id TEXT NOT NULL, model_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_email, agent_id)
);
CREATE TABLE user_last_used_agent (
  user_email TEXT PRIMARY KEY, agent_id TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE user_chat_last_used_agent (
  user_email TEXT NOT NULL, chat_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_email, chat_id)
);
CREATE TABLE user_settings (
  user_email TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_email, key)
);
`;
