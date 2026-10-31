import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

function seedExtended(f) {
  seed(f);
  f.chats.prepare('INSERT INTO user_workflows VALUES (?,?,?,?,?,?)')
    .run('flow', 'user', 'Flow', JSON.stringify({ version: 1, nodes: [
      { id: 'a', agent: 'agent', instruction: 'first', dependsOn: [] },
      { id: 'b', agent: 'agent', instruction: '{{a.output}}', dependsOn: ['a'] },
    ] }), 1, 1);
  f.chats.exec(`INSERT INTO chat_operations VALUES ('user','op','digest','{"ok":true,"versions":{"message":1}}',1);
    INSERT INTO cron_jobs VALUES ('job','agent','user','Job','prompt','{"kind":"daily","hour":12,"minute":0}',
      '0 12 * * *',1,1,1,NULL,NULL,NULL);
    INSERT INTO cron_runs VALUES ('run','job',1,NULL,NULL,'queued',NULL,NULL,NULL);
    INSERT INTO chat_transfers VALUES ('user','transfer','chat','chat',1,2,
      '${createHash('sha256').update('{}').digest('hex')}',1);
    INSERT INTO chat_transfer_chunks VALUES ('user','transfer',0,x'7b7d');
    INSERT INTO shares VALUES ('share','user',1,'Share','[]');`);
}

test('stored workflows, schedules and complete transfer records are readable', async t => {
  const f = await databaseFixture(t, { wal: true });
  seedExtended(f);
  assert.ok((await inspect(f)).databases.every(db => db.status === 'data-supported'));
});

for (const [name, sql] of [
  ['unsafe-integer', 'UPDATE chats SET ts=9007199254740992'],
  ['blob-json', "UPDATE chats SET messages=x'5b5d'"],
  ['null-primary-key', 'UPDATE shares SET share_id=NULL'],
  ['workflow-cycle', `UPDATE user_workflows SET plan_json='{"version":1,"nodes":[{"id":"x","agent":"a","instruction":"text","dependsOn":["x"]}]}'`],
  ['workflow-template', `UPDATE user_workflows SET plan_json='{"version":1,"nodes":[{"id":"x","agent":"a","instruction":"{{missing.output}}","dependsOn":[]}]}'`],
  ['operation-version', `UPDATE chat_operations SET result='{"ok":true,"versions":{"x":-1}}'`],
  ['schedule-mismatch', "UPDATE cron_jobs SET cron_expr='* * * * *'"],
  ['schedule-kind', `UPDATE cron_jobs SET schedule_spec='{"kind":"future"}'`],
  ['timeout', 'UPDATE cron_jobs SET timeout_minutes=1441'],
  ['run-status', "UPDATE cron_runs SET status='future'"],
  ['transfer-range', 'UPDATE chat_transfer_chunks SET chunk_index=1'],
  ['transfer-size', "UPDATE chat_transfer_chunks SET data=x'01'"],
  ['transfer-total', 'UPDATE chat_transfers SET total=2'],
  ['transfer-digest', `UPDATE chat_transfers SET digest='${'a'.repeat(64)}'`],
]) {
  test(`extended persisted content refuses ${name}`, async t => {
    const f = await databaseFixture(t, { wal: true });
    seedExtended(f);
    f.chats.exec(sql);
    await assert.rejects(inspect(f), { code: 'DEPLOYMENT_DATABASE_UNSUPPORTED' });
  });
}

test('unfinished transfers remain valid persisted state', async t => {
  const f = await databaseFixture(t);
  seedExtended(f);
  f.chats.exec('DELETE FROM chat_transfer_chunks');
  assert.ok((await inspect(f)).databases.every(db => db.status === 'data-supported'));
});

test('value allocation budget rejects data before returning a large field', async t => {
  const f = await databaseFixture(t);
  seed(f);
  f.chats.prepare('UPDATE chats SET messages=?').run(' '.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(inspect(f), { check: 'stored-scalar' });
});

test('row budget rejects rather than reporting truncated success', async t => {
  const f = await databaseFixture(t);
  f.chats.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100001)
    INSERT INTO chat_tombstones SELECT 'user', CAST(x AS TEXT), 1 FROM n`);
  await assert.rejects(inspect(f), { check: 'stored-row-budget' });
});

test('schema and content inspect the same WAL read transaction', async t => {
  const f = await databaseFixture(t, { wal: true });
  seed(f);
  let changed = false;
  function Concurrent(file, options) {
    const db = new Database(file, options);
    if (file.endsWith('chats.db')) {
      const prepare = db.prepare.bind(db);
      db.prepare = sql => {
        const statement = prepare(sql);
        if (sql.includes('FROM sqlite_schema') && !changed) {
          const all = statement.all.bind(statement);
          statement.all = (...args) => {
            const rows = all(...args);
            f.chats.exec("UPDATE chats SET messages='private-invalid-json'");
            changed = true;
            return rows;
          };
        }
        return statement;
      };
    }
    return db;
  }
  assert.ok((await inspectDeploymentData({ project: f.project, profile, Database: Concurrent }))
    .databases.every(db => db.status === 'data-supported'));
  assert.equal(changed, true);
  await assert.rejects(inspect(f), { check: 'stored-json' });
});
