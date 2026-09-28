import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { databaseFixture, profile } from './deployment-database-fixture.mjs';
import { prepareDatabaseInspectionCommand, readDatabaseInspectionResult } from '../scripts/deployment/database-command.mjs';

const execute = promisify(execFile);
const modules = fileURLToPath(new URL('../node_modules', import.meta.url));
const snapshot = async directory => Promise.all((await readdir(directory)).sort()
  .filter(name => !name.endsWith('-shm')).map(async name => [name, await readFile(path.join(directory, name))]));
const prepare = f => prepareDatabaseInspectionCommand({
  project: f.project, node: process.execPath, profile, environment: {},
});
const run = command => execute(command.file, command.args, {
  cwd: command.cwd, env: command.env, timeout: 30000, maxBuffer: 8192,
});

for (const wal of [false, true]) {
  test(`captured inspector runs installed SQLite without candidate code or writes: WAL=${wal}`, async t => {
    const f = await databaseFixture(t, { wal });
    await writeFile(path.join(f.project, 'package.json'), '{"type":"module"}');
    await symlink(modules, path.join(f.project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(path.join(f.project, 'scripts', 'deployment'), { recursive: true });
    await writeFile(path.join(f.project, 'scripts', 'deployment', 'database-compatibility.mjs'), 'throw Error("candidate executed")');
    f.chats.exec(`INSERT INTO chats(user_id,chat_id,name,ts) VALUES ('user','chat','retained',1)`);
    const before = await snapshot(f.directory);
    const command = await prepare(f);
    assert.ok(Buffer.byteLength(JSON.stringify(command)) < 65536);
    assert.ok(command.args.join(' ').length < 30000, 'Windows command-line budget');
    const result = readDatabaseInspectionResult(await run(command), profile);
    assert.deepEqual(result, { profile, databases: [
      { name: 'chats.db', status: 'data-supported' }, { name: 'config.db', status: 'data-supported' },
    ] });
    assert.deepEqual(await snapshot(f.directory), before);
  });
}

test('worker inspection does not need a binding for absent first-install data', async t => {
  const f = await databaseFixture(t, { groups: [] });
  assert.ok(readDatabaseInspectionResult(await run(await prepare(f)), profile)
    .databases.every(db => db.status === 'absent'));
  assert.deepEqual(await readdir(f.directory), []);
});

test('invalid persisted data produces a static refusal without stored contents', async t => {
  const f = await databaseFixture(t);
  await symlink(modules, path.join(f.project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  f.chats.exec("INSERT INTO chats(user_id,chat_id,name,ts,messages) VALUES ('user','chat','name',1,'private-invalid-json')");
  const output = await run(await prepare(f));
  assert.doesNotMatch(output.stdout + output.stderr, /private-invalid/);
  assert.throws(() => readDatabaseInspectionResult(output, profile), { check: 'stored-json' });
});

test('captured worker includes first-start legacy inspection without loading a SQLite binding', async t => {
  const f = await databaseFixture(t, { groups: [] });
  await writeFile(path.join(f.project, 'agents.json'), '{"agents":[{"id":"same"},{"id":"same"}]}');
  const output = await run(await prepare(f));
  assert.throws(() => readDatabaseInspectionResult(output, profile), { check: 'legacy-content' });
});

for (const stdout of [
  '{}', '{"ok":true}', 'private-invalid',
  '{"ok":false,"check":"private-secret"}',
  JSON.stringify({ ok: true, result: { profile, databases: [
    { name: 'chats.db', status: 'schema-supported' }, { name: 'config.db', status: 'absent' },
  ] } }),
]) {
  test(`malformed worker results cannot authorize data compatibility (${stdout.length})`, () => {
    assert.throws(() => readDatabaseInspectionResult({ stdout, stderr: '' }, profile), error => {
      assert.equal(error.code, 'DEPLOYMENT_DATABASE_UNSUPPORTED');
      assert.doesNotMatch(JSON.stringify(error) + error.message, /private-/);
      return true;
    });
  });
}
