import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { realDirectory } from './snapshot-files.mjs';
import { databaseGroups, databaseProfile, migrationKeys, referenceSchema } from './database-shape-policy.mjs';
import { inspectDatabaseContent } from './database-content.mjs';
import { inspectLegacyConfiguration } from './legacy-configuration.mjs';

function refusal(check) {
  return Object.assign(new Error(`Database admission refused: ${check}.`), {
    code: 'DEPLOYMENT_DATABASE_UNSUPPORTED', check,
    nextAction: 'Inspect the installed database format and recovery evidence before updating; do not initialize or migrate it to bypass admission.',
  });
}

async function optionalStat(file) {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

const identity = info => ({ dev: info.dev, ino: info.ino });
const normalizedSql = value => value === null ? null : value.match(
  /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\d+|[^\s]/g,
).map(token => ["'", '"', '`', '['].includes(token[0]) ? token : token.toLowerCase()).join('');

function inspectSchema(db, reference, name, signal, content) {
  db.pragma('query_only = ON');
  db.pragma('trusted_schema = OFF');
  return db.transaction(() => {
    signal?.throwIfAborted();
    if (db.pragma('user_version', { simple: true }) !== 0 || db.pragma('application_id', { simple: true }) !== 0) {
      throw refusal('database-version');
    }
    const schema = db.prepare(`SELECT type, substr(name,1,129) AS name, substr(tbl_name,1,129) AS tbl_name,
      substr(sql,1,65537) AS sql FROM sqlite_schema ORDER BY type, name LIMIT 129`).all();
    if (schema.length > 128 || schema.some(row => row.name.length > 128
      || row.tbl_name.length > 128 || row.sql?.length > 65536)) throw refusal('schema-bound');
    const tables = schema.filter(row => row.type === 'table').map(row => row.name);
    const groups = databaseGroups[name];
    const allowed = groups.flat();
    if (!tables.length || tables.some(table => !allowed.includes(table))) throw refusal('table-inventory');
    for (const group of groups) {
      const count = group.filter(table => tables.includes(table)).length;
      if (count && count !== group.length) throw refusal('partial-table-group');
    }
    if (name === 'chats.db' && tables.some(table => ['chat_operations', 'chat_transfers'].includes(table))
      && !tables.includes('chats')) throw refusal('missing-chat-group');
    const expected = reference.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name')
      .all().filter(row => tables.includes(row.tbl_name));
    if (!same(schema.map(row => ({ ...row, sql: normalizedSql(row.sql) })),
      expected.map(row => ({ ...row, sql: normalizedSql(row.sql) })))) throw refusal('schema-definition');
    for (const table of tables) {
      signal?.throwIfAborted();
      // Names come only from the fixed allowlist above, never arbitrary database text.
      for (const pragma of ['table_xinfo', 'foreign_key_list', 'index_list']) {
        if (!same(db.pragma(`${pragma}("${table}")`), reference.pragma(`${pragma}("${table}")`))) {
          throw refusal('schema-metadata');
        }
      }
    }
    if (name === 'config.db') {
      const keys = db.prepare('SELECT key FROM migrations ORDER BY key LIMIT 6').all().map(row => row.key);
      if (!same(keys, migrationKeys)) throw refusal('migration-receipts');
    }
    if (tables.includes('orchestrations')) {
      if (db.prepare('SELECT 1 FROM orchestrations LIMIT 1').get()
        || db.prepare('SELECT 1 FROM orchestration_nodes LIMIT 1').get()) throw refusal('destructive-startup');
    }
    signal?.throwIfAborted();
    if (content) inspectDatabaseContent(db, tables, signal, refusal);
    return { name, status: content ? 'data-supported' : 'schema-supported' };
  })();
}

async function inspectDatabase({ directory, name, Database, reference, signal, content }) {
  const file = path.join(directory, name);
  const files = [file, `${file}-wal`, `${file}-shm`, `${file}-journal`];
  const initial = await Promise.all(files.map(optionalStat));
  if (initial[3]) throw refusal('rollback-journal');
  if (!initial[0]) {
    if (initial.some(Boolean)) throw refusal('orphan-sidecar');
    return { name, status: 'absent' };
  }
  const handles = [];
  let db;
  try {
    for (let index = 0; index < 3; index++) {
      const info = initial[index];
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw refusal('file-type');
      const handle = await open(files[index], constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      handles.push(handle);
      if (!same(identity(await handle.stat({ bigint: true })), identity(info))) throw refusal('file-replaced');
    }
    const header = Buffer.alloc(100);
    const { bytesRead } = await handles[0].read(header, 0, header.length, 0);
    if (bytesRead !== 100 || header.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0'
      || ![1, 2].includes(header[18]) || header[18] !== header[19]) throw refusal('sqlite-header');
    const wal = header[18] === 2;
    if (wal ? !initial[1] || !initial[2] || initial[1].size < 32n || initial[2].size < 32768n
      : initial[1] || initial[2]) throw refusal('sidecar-inventory');
    signal?.throwIfAborted();
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 });
    const result = inspectSchema(db, reference, name, signal, content);
    db.close();
    db = null;
    const after = await Promise.all(files.map(optionalStat));
    if (after.some((info, index) => Boolean(info) !== Boolean(initial[index])
      || info && (!same(identity(info), identity(initial[index])) || !info.isFile()
        || info.isSymbolicLink() || info.nlink !== 1n))) throw refusal('file-replaced');
    return result;
  } finally {
    try { db?.close(); }
    finally {
      const results = await Promise.allSettled(handles.map(handle => handle.close()));
      if (results.some(result => result.status === 'rejected')) throw refusal('file-close');
    }
  }
}

async function inspectDatabases({ project, profile, signal, Database: suppliedDatabase }, content) {
  signal?.throwIfAborted();
  if (profile !== databaseProfile) throw refusal('unsupported-profile');
  let reference;
  try {
    const root = await realDirectory(project);
    const directory = path.join(root, '.data');
    const original = await optionalStat(directory);
    if (!original) {
      if (content) await inspectLegacyConfiguration({ project: root, signal });
      return { profile, databases: Object.keys(databaseGroups).map(name => ({ name, status: 'absent' })) };
    }
    await realDirectory(directory);
    if ((await readdir(directory)).some(name => /\.(?:db|db-wal|db-shm|db-journal)$/i.test(name)
      && !Object.keys(databaseGroups).some(base => [base, `${base}-wal`, `${base}-shm`, `${base}-journal`].includes(name)))) {
      throw refusal('database-inventory');
    }
    let Database = suppliedDatabase;
    const databases = [];
    for (const name of Object.keys(databaseGroups)) {
      signal?.throwIfAborted();
      if (!reference && await optionalStat(path.join(directory, name))) {
        Database ??= createRequire(path.join(root, 'package.json'))('better-sqlite3');
        reference = new Database(':memory:');
        reference.exec(referenceSchema);
      }
      databases.push(await inspectDatabase({ directory, name, Database, reference, signal, content }));
    }
    if (content && databases.find(db => db.name === 'config.db').status === 'absent') {
      await inspectLegacyConfiguration({ project: root, signal });
    }
    const current = await optionalStat(directory);
    if (!current || !same(identity(original), identity(current))) throw refusal('directory-replaced');
    await realDirectory(directory);
    return { profile, databases };
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'DEPLOYMENT_DATABASE_UNSUPPORTED') throw error;
    throw refusal('inspection-unavailable');
  } finally { reference?.close(); }
}

export const inspectDeploymentDatabases = options => inspectDatabases(options, false);
export const inspectDeploymentData = options => inspectDatabases(options, true);
