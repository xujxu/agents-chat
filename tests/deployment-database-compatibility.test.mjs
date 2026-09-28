import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { link, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { databaseFixture, profile } from './deployment-database-fixture.mjs';
import { inspectDeploymentDatabases } from '../scripts/deployment/database-compatibility.mjs';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { runDeployment } from '../scripts/deployment/transaction.mjs';

// Test installations share the actual repository binding without installing into each fixture.
const Database = createRequire(import.meta.url)('better-sqlite3');
const inspect = f => inspectDeploymentDatabases({ project: f.project, profile, Database });
const snapshot = async directory => {
  const names = (await readdir(directory)).sort();
  return { names, bytes: await Promise.all(names.filter(name => !name.endsWith('-shm')).map(async name =>
    [name, await readFile(path.join(directory, name))])) };
};

for (const wal of [false, true]) {
  test(`historical schema inspection is read-only with committed WAL=${wal}`, async t => {
    const f = await databaseFixture(t, { wal });
    const before = await snapshot(f.directory);
    const result = await inspect(f);
    assert.deepEqual(result, { profile, databases: [
      { name: 'chats.db', status: 'schema-supported' }, { name: 'config.db', status: 'schema-supported' },
    ] });
    assert.deepEqual(await snapshot(f.directory), before);
    assert.equal(f.chats.prepare('SELECT count(*) AS n FROM chats').get().n, 0);
  });
}

test('missing databases are classified without creating state or invoking SQLite', async t => {
  const project = await temporaryDeployment(t);
  const result = await inspectDeploymentDatabases({ project, profile, Database() { throw new Error('must not open'); } });
  assert.ok(result.databases.every(database => database.status === 'absent'));
  assert.deepEqual(await readdir(project), []);
});

for (const groups of [['chat'], ['schedule'], ['chat', 'transfer'], ['config']]) {
  test(`lazy table groups are permitted independently: ${groups.join(',')}`, async t => {
    const f = await databaseFixture(t, { groups });
    assert.equal((await inspect(f)).databases.filter(database => database.status === 'schema-supported').length, 1);
  });
}

for (const [name, sql] of [
  ['table', 'CREATE TABLE future_private_name(secret TEXT)'],
  ['column', 'ALTER TABLE chats ADD COLUMN future_secret TEXT'],
  ['missing-column', 'ALTER TABLE chats DROP COLUMN agent_id'],
  ['partial-group', 'DROP TABLE cron_runs'],
  ['index', 'CREATE INDEX unknown_index ON chats(name)'],
  ['changed-index', 'DROP INDEX idx_chats_user_ts; CREATE INDEX idx_chats_user_ts ON chats(name)'],
  ['type', 'DROP TABLE shares; CREATE TABLE shares(share_id TEXT PRIMARY KEY, shared_by TEXT NOT NULL, shared_at TEXT NOT NULL, name TEXT NOT NULL, messages TEXT NOT NULL DEFAULT \'[]\')'],
  ['default', 'DROP TABLE shares; CREATE TABLE shares(share_id TEXT PRIMARY KEY, shared_by TEXT NOT NULL, shared_at INTEGER NOT NULL, name TEXT NOT NULL, messages TEXT NOT NULL DEFAULT \'[ ]\')'],
  ['constraint', 'DROP TABLE shares; CREATE TABLE shares(share_id TEXT PRIMARY KEY, shared_by TEXT NOT NULL, shared_at INTEGER NOT NULL, name TEXT NOT NULL CHECK(name != \'private-value\'), messages TEXT NOT NULL DEFAULT \'[]\')'],
  ['view', 'CREATE VIEW secret_view AS SELECT name FROM chats'],
  ['trigger', "CREATE TRIGGER secret_trigger AFTER INSERT ON chats BEGIN DELETE FROM chats; END"],
  ['version', 'PRAGMA user_version = 88'],
  ['application', 'PRAGMA application_id = 88'],
  ['orchestration', "INSERT INTO orchestrations VALUES ('private-id','private-user','chat','mode','{}',0,1)"],
  ['orphan-node', "PRAGMA foreign_keys=OFF; INSERT INTO orchestration_nodes VALUES ('private-id','node','running',NULL,1)"],
]) {
  test(`unknown/destructive database shape is refused without writes: ${name}`, async t => {
    const f = await databaseFixture(t, { wal: true });
    f.chats.exec(sql);
    const before = await snapshot(f.directory);
    await assert.rejects(inspect(f), error => {
      assert.equal(error.code, 'DEPLOYMENT_DATABASE_UNSUPPORTED');
      assert.match(error.nextAction, /Inspect/);
      assert.doesNotMatch(error.message, /secret|private-id|private-user|future_private/);
      return true;
    });
    assert.deepEqual(await snapshot(f.directory), before);
  });
}

for (const change of ['unknown', 'missing']) {
  test(`migration receipts are bounded known keys, not a schema version: ${change}`, async t => {
    const f = await databaseFixture(t);
    f.config.exec(change === 'unknown' ? "INSERT INTO migrations(key) VALUES ('secret_future')"
      : "DELETE FROM migrations WHERE key='add_env_column'");
    const before = await snapshot(f.directory);
    await assert.rejects(inspect(f), { code: 'DEPLOYMENT_DATABASE_UNSUPPORTED' });
    assert.deepEqual(await snapshot(f.directory), before);
  });
}

test('WAL-only incompatible schema cannot be hidden by inspecting only the main file', async t => {
  const f = await databaseFixture(t, { groups: ['chat'], wal: true });
  f.chats.pragma('wal_checkpoint(TRUNCATE)');
  const main = await readFile(path.join(f.directory, 'chats.db'));
  f.chats.exec('ALTER TABLE chats ADD COLUMN incompatible TEXT');
  assert.deepEqual(await readFile(path.join(f.directory, 'chats.db')), main);
  await assert.rejects(inspect(f), { code: 'DEPLOYMENT_DATABASE_UNSUPPORTED' });
});

test('closed WAL database with absent sidecars is refused without creating them', async t => {
  const f = await databaseFixture(t, { groups: ['chat'], wal: true });
  f.chats.close();
  const before = await snapshot(f.directory);
  await assert.rejects(inspect(f), { code: 'DEPLOYMENT_DATABASE_UNSUPPORTED' });
  assert.deepEqual(await snapshot(f.directory), before);
});

for (const change of ['corrupt', 'journal', 'orphan-wal']) {
  test(`unsafe database files are rejected before opening: ${change}`, async t => {
    const f = await databaseFixture(t, { groups: ['chat'] });
    f.chats.close();
    if (change === 'corrupt') await writeFile(path.join(f.directory, 'chats.db'), 'not sqlite secret');
    if (change === 'journal') await writeFile(path.join(f.directory, 'chats.db-journal'), 'incomplete');
    if (change === 'orphan-wal') {
      await unlink(path.join(f.directory, 'chats.db'));
      await writeFile(path.join(f.directory, 'chats.db-wal'), 'orphan');
    }
    const before = await snapshot(f.directory);
    await assert.rejects(inspect(f), { code: 'DEPLOYMENT_DATABASE_UNSUPPORTED' });
    assert.deepEqual(await snapshot(f.directory), before);
  });
}

test('database inspector cannot silently authorize an unsupported target profile', async t => {
  const f = await databaseFixture(t);
  await assert.rejects(inspectDeploymentDatabases({ project: f.project, profile: 'future', Database }),
    { code: 'DEPLOYMENT_DATABASE_UNSUPPORTED' });
});

test('cancellation is observed before database inspection', async t => {
  const f = await databaseFixture(t);
  await assert.rejects(inspectDeploymentDatabases({
    project: f.project, profile, Database, signal: AbortSignal.abort(),
  }), { name: 'AbortError' });
});

test('binding receives read-only/fileMustExist options and original database paths', async t => {
  const f = await databaseFixture(t);
  const seen = [];
  function Observed(file, options) {
    seen.push({ file, options });
    return new Database(file, options);
  }
  await inspectDeploymentDatabases({ project: f.project, profile, Database: Observed });
  for (const name of ['chats', 'config']) {
    assert.ok(seen.some(call => call.file === path.join(f.directory, `${name}.db`)
      && call.options.readonly === true && call.options.fileMustExist === true));
  }
});

test('default inspector resolves the binding from the installed project', async t => {
  const f = await databaseFixture(t);
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(f.project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok((await inspectDeploymentDatabases({ project: f.project, profile })).databases
    .every(database => database.status === 'schema-supported'));
});

test('hard-linked database is refused before SQLite opens the application', async t => {
  const f = await databaseFixture(t, { groups: ['chat'] });
  await link(path.join(f.directory, 'chats.db'), path.join(f.project, 'linked.db'));
  const before = await snapshot(f.directory);
  await assert.rejects(inspect(f), { check: 'file-type' });
  assert.deepEqual(await snapshot(f.directory), before);
});

test('additional application database is not silently omitted', async t => {
  const f = await databaseFixture(t);
  await writeFile(path.join(f.directory, 'future.db'), '');
  await assert.rejects(inspect(f), { check: 'database-inventory' });
});

test('successful shape inspection alone cannot authorize transaction downtime', async t => {
  const f = await databaseFixture(t);
  const calls = [];
  const operations = Object.fromEntries(['record', 'capacity', 'stop', 'snapshot', 'verifySnapshot',
    'rotate', 'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify']
    .map(name => [name, async () => { calls.push(name); }]));
  operations.inspect = async () => ({ exists: true, running: true, owned: true });
  operations.resolveTarget = async () => ({ commit: 'a'.repeat(40) });
  operations.admit = async () => inspect(f);
  await assert.rejects(runDeployment({ operation: 'update' }, operations), /compatibility admission/);
  assert.deepEqual(calls, []);
});

test('compatibility failure is propagated before transaction stop or state mutation', async t => {
  const f = await databaseFixture(t);
  f.chats.exec('CREATE TABLE future(secret TEXT)');
  const calls = [];
  const operations = Object.fromEntries(['record', 'capacity', 'stop', 'snapshot', 'verifySnapshot',
    'rotate', 'selectSource', 'dependencies', 'build', 'configure', 'start', 'verify']
    .map(name => [name, async () => { calls.push(name); }]));
  operations.inspect = async () => ({ exists: true, running: true, owned: true });
  operations.resolveTarget = async () => ({ commit: 'a'.repeat(40) });
  operations.admit = async () => inspect(f);
  await assert.rejects(runDeployment({ operation: 'update' }, operations), { code: 'DEPLOYMENT_DATABASE_UNSUPPORTED' });
  assert.deepEqual(calls, []);
});
