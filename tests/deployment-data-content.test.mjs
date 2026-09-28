import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { databaseFixture, profile } from './deployment-database-fixture.mjs';
import { inspectDeploymentData } from '../scripts/deployment/database-compatibility.mjs';

const Database = createRequire(import.meta.url)('better-sqlite3');
const inspect = f => inspectDeploymentData({ project: f.project, profile, Database });
const bytes = async f => Promise.all((await readdir(f.directory)).sort()
  .filter(name => !name.endsWith('-shm')).map(async name => [name, await readFile(path.join(f.directory, name))]));
const message = { id: 'message', type: 'user', content: 'private-data', ts: 1 };
function seed(f) {
  f.chats.prepare(`INSERT INTO chats(user_id,chat_id,name,ts,messages,agent_sessions)
    VALUES ('user','chat','name',1,?,?)`).run(JSON.stringify([message]), '{"agent":["session1","session2"]}');
  f.config.exec("INSERT INTO agents(id,name) VALUES ('agent','Agent')");
}

test('content admission reads populated historical WAL without changing bytes', async t => {
  const f = await databaseFixture(t, { wal: true });
  seed(f);
  const before = await bytes(f);
  assert.deepEqual(await inspect(f), { profile, databases: [
    { name: 'chats.db', status: 'data-supported' }, { name: 'config.db', status: 'data-supported' },
  ] });
  assert.deepEqual(await bytes(f), before);
});

for (const [name, sql] of [
  ['malformed-json', "UPDATE chats SET messages='private-invalid-json'"],
  ['messages-object', "UPDATE chats SET messages='{}'"],
  ['message-fields', "UPDATE chats SET messages='[{\"id\":\"x\",\"type\":\"future\",\"content\":\"private-data\",\"ts\":1}]'"],
  ['duplicate-message', `UPDATE chats SET messages='${JSON.stringify([message, message])}'`],
  ['sessions', "UPDATE chats SET agent_sessions='{\"agent\":7}'"],
  ['git-context', "UPDATE chats SET git_context='{\"repoRoot\":7}'"],
  ['scalar', "UPDATE chats SET ts='private-invalid-number'"],
  ['args', "UPDATE agents SET args='[7]'"],
  ['env', "UPDATE agents SET env='{\"SECRET\":7}'"],
  ['models', "UPDATE agents SET models='[{\"modelId\":\"x\"},{\"modelId\":\"x\"}]'"],
  ['model-selection', "UPDATE agents SET models='[{\"modelId\":\"x\"}]', default_model_id='other'"],
  ['boolean', 'UPDATE agents SET yolo=9'],
  ['foreign-key', "INSERT INTO agent_access(agent_id,email,granted_by) VALUES ('missing','user','admin')"],
]) {
  test(`content admission rejects incompatible stored values: ${name}`, async t => {
    const f = await databaseFixture(t, { wal: true });
    seed(f);
    const config = ['args', 'env', 'models', 'model-selection', 'boolean', 'foreign-key'].includes(name);
    const db = config ? f.config : f.chats;
    if (name === 'foreign-key') db.pragma('foreign_keys = OFF');
    db.exec(sql);
    const before = await bytes(f);
    await assert.rejects(inspect(f), error => {
      assert.equal(error.code, 'DEPLOYMENT_DATABASE_UNSUPPORTED');
      assert.doesNotMatch(JSON.stringify(error) + error.message, /private-|SECRET/);
      return true;
    });
    assert.deepEqual(await bytes(f), before);
  });
}

test('data admission detects WAL-only invalid content', async t => {
  const f = await databaseFixture(t, { wal: true });
  seed(f);
  f.chats.pragma('wal_checkpoint(TRUNCATE)');
  const main = await readFile(path.join(f.directory, 'chats.db'));
  f.chats.exec("UPDATE chats SET messages='false'");
  assert.deepEqual(await readFile(path.join(f.directory, 'chats.db')), main);
  await assert.rejects(inspect(f), { code: 'DEPLOYMENT_DATABASE_UNSUPPORTED' });
});

test('integrity failures do not expose SQLite diagnostic data', async t => {
  const f = await databaseFixture(t);
  function Corrupt(file, options) {
    const db = new Database(file, options);
    if (file !== ':memory:') {
      const prepare = db.prepare.bind(db);
      db.prepare = sql => sql.includes('integrity_check') ? {
        get: () => ({ integrity_check: 'private-record-corruption' }),
      } : prepare(sql);
    }
    return db;
  }
  await assert.rejects(inspectDeploymentData({ project: f.project, profile, Database: Corrupt }), error => {
    assert.equal(error.check, 'database-integrity');
    assert.doesNotMatch(error.message, /private-record/);
    return true;
  });
});

test('no database remains a valid first-install data observation', async t => {
  const f = await databaseFixture(t, { groups: [] });
  assert.ok((await inspect(f)).databases.every(db => db.status === 'absent'));
});
