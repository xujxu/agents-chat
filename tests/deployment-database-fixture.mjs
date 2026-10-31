import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { temporaryDeployment } from './deployment-fixture.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const sources = [
  ['chat', 'aa201f3edc25e3d66bc76e9453c1cb3cda55db99'],
  ['config', '7f037928778e147cc68e46c550bf109759227765'],
  ['sync', '005a819da01dff4e5dd512e40658ebdbdf4ebbb5'],
  ['transfer', 'bb03a556703881ff086aa958db22ebbe6bf0cc17'],
  ['schedule', 'ecb14acd9f5f1107094e9621ba4da7cb273e56cd'],
];
const ddl = new Map();
for (const [group, blob] of sources) {
  const { stdout } = await execute('git', ['-C', repository, 'cat-file', 'blob', blob], { encoding: 'buffer' });
  const actual = createHash('sha1').update(`blob ${stdout.length}\0`).update(stdout).digest('hex');
  if (actual !== blob) throw new Error('Historical fixture provenance changed.');
  const statements = stdout.toString('utf8').match(/CREATE (?:TABLE|INDEX) IF NOT EXISTS [^`]*?(?:;|(?=`))/g);
  if (!statements?.length) throw new Error('Historical fixture DDL missing.');
  ddl.set(group, statements.join('\n'));
}

export const profile = 'agents-chat-638c553';

export async function databaseFixture(t, { groups = ['chat', 'sync', 'transfer', 'schedule', 'config'], wal = false } = {}) {
  const dbs = {};
  t.after(() => { for (const db of Object.values(dbs)) if (db.open) db.close(); });
  const project = await temporaryDeployment(t);
  const directory = path.join(project, '.data');
  await mkdir(directory);
  for (const name of ['chats', 'config']) {
    const chosen = groups.filter(group => (group === 'config') === (name === 'config'));
    if (!chosen.length) continue;
    const db = new Database(path.join(directory, `${name}.db`));
    dbs[name] = db;
    if (wal) { db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0'); }
    for (const group of chosen) {
      try { db.exec(ddl.get(group)); }
      catch (cause) { throw new Error(`Historical fixture DDL failed: ${group}: ${cause.message}`, { cause }); }
    }
    if (chosen.includes('chat')) db.exec("ALTER TABLE chats ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''");
    if (chosen.includes('schedule')) db.exec('ALTER TABLE cron_jobs ADD COLUMN timeout_minutes INTEGER');
    if (name === 'config') {
      const insert = db.prepare('INSERT INTO migrations(key) VALUES (?)');
      for (const key of ['agents_json_import', 'nodes_json_import', 'add_public_column', 'add_agent_model_columns', 'add_env_column']) {
        insert.run(key);
      }
    }
  }
  return { project, directory, ...dbs };
}
