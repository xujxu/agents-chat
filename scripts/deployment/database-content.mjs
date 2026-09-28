import { validateWorkflowPlan } from '../../lib/workflow/workflowSchema.mjs';
import { createHash } from 'node:crypto';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string';
const strings = value => Array.isArray(value) && value.every(string);
const number = value => typeof value === 'number' && Number.isFinite(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const optional = (value, keys, predicate) => keys.every(key => value[key] === undefined || predicate(value[key]));
const flag = value => value === 0 || value === 1;
const maxBytes = 16 * 1024 * 1024;
const maxRows = 100_000;

function message(value) {
  return record(value) && string(value.id) && value.id.length > 0
    && ['user', 'agent', 'system'].includes(value.type) && string(value.content) && number(value.ts)
    && optional(value, ['agentId', 'relation', 'sendError', 'resendMessage', 'statusText', 'ptyPhase'], string)
    && optional(value, ['pending', 'summary', 'serverManaged'], item => typeof item === 'boolean')
    && optional(value, ['round'], number)
    && optional(value, ['version'], item => integer(item, 0, Number.MAX_SAFE_INTEGER))
    && optional(value, ['sendStatus'], item => ['failed', 'pending'].includes(item))
    && optional(value, ['parts'], Array.isArray) && optional(value, ['resendAgentIds'], strings)
    && optional(value, ['attachments'], items => Array.isArray(items) && items.every(item =>
      record(item) && ['id', 'name', 'mimeType', 'dataUrl'].every(key => string(item[key]))
      && number(item.size) && item.size >= 0 && ['image', 'file'].includes(item.kind)));
}

function messages(value) {
  return Array.isArray(value) && value.every(message)
    && new Set(value.map(item => item.id)).size === value.length;
}

function schedule(value, cron) {
  if (!record(value)) return false;
  if (value.kind === 'every_minutes') {
    return integer(value.interval, 1, 59) && cron === `*/${value.interval} * * * *`;
  }
  if (value.kind === 'every_hours') {
    return integer(value.interval, 1, 23) && cron === `0 */${value.interval} * * *`;
  }
  if (!integer(value.hour, 0, 23) || !integer(value.minute, 0, 59)) return false;
  if (value.kind === 'daily') return cron === `${value.minute} ${value.hour} * * *`;
  if (value.kind === 'every_days') {
    return integer(value.interval, 1, 30) && cron === `${value.minute} ${value.hour} */${value.interval} * *`;
  }
  return value.kind === 'weekly' && Array.isArray(value.weekdays) && value.weekdays.length > 0
    && value.weekdays.every(day => integer(day, 0, 6))
    && cron === `${value.minute} ${value.hour} * * ${[...value.weekdays].sort((a, b) => a - b).join(',')}`;
}

export function inspectPersistedRow(table, row, refuse) {
  const require = valid => { if (!valid) throw refuse('stored-content'); };
  const json = field => {
    try { return JSON.parse(row[field]); }
    catch { throw refuse('stored-json'); }
  };
  if (table === 'chats' || table === 'shares') require(messages(json('messages')));
  if (table === 'chats') {
    const sessions = json('agent_sessions');
    const git = json('git_context');
    require(record(sessions) && Object.values(sessions).every(value => string(value) || strings(value)));
    require(record(git) && (Object.keys(git).length === 0
      || ['repoRoot', 'worktreePath', 'branchName'].every(key => string(git[key]))
        && optional(git, ['isFallback'], value => typeof value === 'boolean')));
  }
  if (table === 'agents') {
    const env = json('env');
    const models = json('models');
    require(strings(json('args')) && record(env) && Object.values(env).every(string));
    require(['yolo', 'no_tools', 'relay', 'public'].every(key => flag(row[key])));
    require(Array.isArray(models) && models.every(model => record(model) && string(model.modelId)
      && model.modelId.trim().length > 0 && optional(model, ['name', 'description'], string))
      && new Set(models.map(model => model.modelId.trim())).size === models.length);
    require(!row.default_model_id.trim() || !models.length
      || models.some(model => model.modelId.trim() === row.default_model_id.trim()));
  }
  if (table === 'user_workflows') {
    const plan = json('plan_json');
    require(record(plan) && Array.isArray(plan.nodes) && plan.nodes.length <= 128
      && plan.nodes.every(node => record(node) && Array.isArray(node.dependsOn) && node.dependsOn.length <= 128)
      && validateWorkflowPlan(plan).ok);
  }
  if (table === 'chat_operations') {
    const result = json('result');
    require(record(result) && result.ok === true && record(result.versions)
      && Object.values(result.versions).every(value => integer(value, 0, Number.MAX_SAFE_INTEGER)));
  }
  if (table === 'cron_jobs') {
    require(flag(row.enabled) && schedule(json('schedule_spec'), row.cron_expr)
      && (row.timeout_minutes === null || integer(row.timeout_minutes, 1, 1440)));
  }
  if (table === 'cron_runs') require(['queued', 'running', 'success', 'error', 'skipped'].includes(row.status));
  if (table === 'chat_transfers') {
    require(['chat', 'acp'].includes(row.purpose) && integer(row.bytes, 1, 64 * 1024 * 1024)
      && row.total === Math.ceil(row.bytes / (256 * 1024)) && /^[a-f0-9]{64}$/.test(row.digest));
  }
}

export function inspectDatabaseContent(db, tables, signal, refuse) {
  signal?.throwIfAborted();
  if (db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok') throw refuse('database-integrity');
  if (db.prepare('PRAGMA foreign_key_check').get()) throw refuse('database-foreign-key');
  for (const table of tables) {
    signal?.throwIfAborted();
    // Table/column identifiers have already matched the fixed reference schema.
    const columns = db.pragma(`table_xinfo("${table}")`);
    const invalid = columns.map(column => {
      const name = `"${column.name}"`;
      const type = { TEXT: 'text', INTEGER: 'integer', BLOB: 'blob' }[column.type];
      if (!type) throw refuse('stored-type-policy');
      return `(${name} IS NULL AND ${column.notnull || column.pk ? 1 : 0})
        OR (${name} IS NOT NULL AND (typeof(${name}) != '${type}'
        OR length(CAST(${name} AS BLOB)) > ${maxBytes}
        ${type === 'integer' ? `OR ${name} NOT BETWEEN -9007199254740991 AND 9007199254740991` : ''}))`;
    }).join(' OR ');
    if (db.prepare(`SELECT 1 FROM "${table}" WHERE ${invalid} LIMIT 1`).get()) throw refuse('stored-scalar');
    if (db.prepare(`SELECT count(*) AS count FROM (SELECT 1 FROM "${table}" LIMIT ${maxRows + 1})`).get().count > maxRows) {
      throw refuse('stored-row-budget');
    }
    const projection = columns.map(column => column.type === 'BLOB'
      ? `length("${column.name}") AS "${column.name}"` : `"${column.name}"`).join(',');
    for (const row of db.prepare(`SELECT ${projection} FROM "${table}"`).iterate()) {
      signal?.throwIfAborted();
      inspectPersistedRow(table, row, refuse);
    }
  }
  if (tables.includes('chat_transfer_chunks') && db.prepare(`SELECT 1 FROM chat_transfer_chunks c
    JOIN chat_transfers t ON c.user_id=t.user_id AND c.transfer_id=t.id
    WHERE c.chunk_index < 0 OR c.chunk_index >= t.total OR length(c.data) !=
      CASE WHEN c.chunk_index=t.total-1 THEN t.bytes-c.chunk_index*262144 ELSE 262144 END LIMIT 1`).get()) {
    throw refuse('stored-transfer');
  }
  if (tables.includes('chat_transfers')) {
    const chunks = db.prepare(`SELECT data FROM chat_transfer_chunks
      WHERE user_id=? AND transfer_id=? ORDER BY chunk_index`);
    for (const transfer of db.prepare('SELECT user_id,id,total,digest FROM chat_transfers').iterate()) {
      const hash = createHash('sha256');
      let count = 0;
      for (const chunk of chunks.iterate(transfer.user_id, transfer.id)) {
        signal?.throwIfAborted();
        hash.update(chunk.data);
        count++;
      }
      if (count === transfer.total && hash.digest('hex') !== transfer.digest) throw refuse('stored-transfer-digest');
    }
  }
  signal?.throwIfAborted();
}
