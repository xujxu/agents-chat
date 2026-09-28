import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { databaseFixture, profile } from './deployment-database-fixture.mjs';
import { inspectDeploymentData } from '../scripts/deployment/database-compatibility.mjs';
import { inspectLegacyConfiguration } from '../scripts/deployment/legacy-configuration.mjs';

const agent = { id: 'agent', name: 'Agent', command: 'copilot', args: ['--acp'],
  models: [{ modelId: 'model' }], defaultModelId: 'model', env: { KEY: 'private-value' } };

test('valid historical JSON imports are read without creating config.db or changing files', async t => {
  const f = await databaseFixture(t, { groups: [] });
  const agents = JSON.stringify({ agents: [agent, { id: 'minimal' }] });
  await writeFile(path.join(f.project, 'agents.json'), agents);
  await writeFile(path.join(f.project, 'nodes.json'), '{"nodes":[{"name":"node","label":"Node"}]}');
  const result = await inspectDeploymentData({ project: f.project, profile });
  assert.ok(result.databases.every(db => db.status === 'absent'));
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(await readFile(path.join(f.project, 'agents.json'), 'utf8'), agents);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});

for (const [name, value] of [
  ['malformed', 'private-invalid-json'],
  ['wrong-root', '[]'],
  ['missing-list', '{}'],
  ['wrong-list', '{"agents":{}}'],
  ['duplicate', JSON.stringify({ agents: [agent, agent] })],
  ['missing-id', '{"agents":[{}]}'],
  ['args', JSON.stringify({ agents: [{ ...agent, args: [7] }] })],
  ['environment', JSON.stringify({ agents: [{ ...agent, env: { KEY: 7 } }] })],
  ['model', JSON.stringify({ agents: [{ ...agent, defaultModelId: 'missing' }] })],
  ['flag', JSON.stringify({ agents: [{ ...agent, relay: 'false' }] })],
]) {
  test(`first-start importer refuses incompatible agent JSON: ${name}`, async t => {
    const f = await databaseFixture(t, { groups: [] });
    await writeFile(path.join(f.project, 'agents.json'), value);
    await assert.rejects(inspectDeploymentData({ project: f.project, profile }), error => {
      assert.equal(error.code, 'DEPLOYMENT_DATABASE_UNSUPPORTED');
      assert.doesNotMatch(error.message + JSON.stringify(error), /private-|KEY/);
      return true;
    });
  });
}

test('duplicate legacy nodes cannot be silently ignored during import', async t => {
  const f = await databaseFixture(t, { groups: [] });
  await writeFile(path.join(f.project, 'nodes.json'), '{"nodes":[{"name":"same"},{"name":"same"}]}');
  await assert.rejects(inspectDeploymentData({ project: f.project, profile }), { check: 'legacy-content' });
});

test('import receipts make dormant legacy JSON irrelevant to the current database', async t => {
  const f = await databaseFixture(t);
  await writeFile(path.join(f.project, 'agents.json'), 'private-invalid-but-already-imported');
  const { default: Database } = await import('better-sqlite3');
  assert.ok((await inspectDeploymentData({ project: f.project, profile, Database }))
    .databases.every(db => db.status === 'data-supported'));
});

test('legacy JSON observations retain both present bytes and absence for recheck', async t => {
  const f = await databaseFixture(t, { groups: [] });
  await writeFile(path.join(f.project, 'agents.json'), '{"agents":[]}');
  const result = await inspectLegacyConfiguration({ project: f.project });
  await result.check();
  await writeFile(path.join(f.project, 'nodes.json'), '{"nodes":[]}');
  await assert.rejects(result.check(), { check: 'legacy-changed' });
});
