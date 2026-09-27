import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectSource, resolveTarget, selectSource } from '../scripts/deployment/source.mjs';

const execute = promisify(execFile);
async function git(project, args) {
  const { stdout } = await execute('git', ['-C', project, ...args], { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function repository(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  await mkdir(project);
  await git(project, ['init', '--initial-branch=main']);
  await git(project, ['config', 'user.name', 'Deployment fixture']);
  await git(project, ['config', 'user.email', 'fixture@example.invalid']);
  await git(project, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(project, 'app.txt'), 'old application\n');
  await writeFile(path.join(project, 'agents.json'), '{"agents":[]}\n');
  await writeFile(path.join(project, '.gitignore'), '.env.local\n');
  await git(project, ['add', '.']);
  await git(project, ['commit', '-m', 'old']);
  const old = await git(project, ['rev-parse', 'HEAD']);
  await writeFile(path.join(project, 'app.txt'), 'new application\n');
  await git(project, ['commit', '-am', 'new']);
  const next = await git(project, ['rev-parse', 'HEAD']);
  await git(project, ['switch', '--detach', old]);
  return { root, project, old, next };
}

test('target resolution never switches the running checkout', async t => {
  const { project, old, next } = await repository(t);
  const inspected = await inspectSource(project);
  assert.equal(inspected.commit, old);
  assert.equal(inspected.branch, null);
  const target = await resolveTarget(project, { revision: next });
  assert.equal(target.commit, next);
  assert.equal(await git(project, ['rev-parse', 'HEAD']), old);
  assert.equal(await readFile(path.join(project, 'app.txt'), 'utf8'), 'old application\n');
});

test('runtime configuration is preserved across explicit source selection', async t => {
  const { project, old, next } = await repository(t);
  const config = '{"agents":[{"name":"local"}]}\n';
  await writeFile(path.join(project, 'agents.json'), config);
  await writeFile(path.join(project, '.env.local'), 'PRIVATE_FIXTURE=unchanged\n');
  const source = await inspectSource(project);
  assert.deepEqual(source.modifiedRuntime, ['agents.json']);
  await selectSource(project, { commit: next, expectedSourceCommit: old });
  assert.equal(await git(project, ['rev-parse', 'HEAD']), next);
  assert.equal(await readFile(path.join(project, 'agents.json'), 'utf8'), config);
  assert.equal(await readFile(path.join(project, '.env.local'), 'utf8'), 'PRIVATE_FIXTURE=unchanged\n');
});

test('source selection rejects edits and a stale source receipt without resetting', async t => {
  const { project, old, next } = await repository(t);
  await writeFile(path.join(project, 'app.txt'), 'uncommitted work\n');
  await assert.rejects(inspectSource(project), /dirty|modified/i);
  await assert.rejects(selectSource(project, { commit: next, expectedSourceCommit: old }), /dirty|modified/i);
  assert.equal(await readFile(path.join(project, 'app.txt'), 'utf8'), 'uncommitted work\n');
  await writeFile(path.join(project, 'app.txt'), 'old application\n');
  await assert.rejects(selectSource(project, { commit: next, expectedSourceCommit: next }), /changed|receipt/i);
  assert.equal(await git(project, ['rev-parse', 'HEAD']), old);
});

test('no-pull works without upstream; normal upgrade requires a tracking branch', async t => {
  const { project, old } = await repository(t);
  assert.equal((await resolveTarget(project, { noPull: true })).commit, old);
  await assert.rejects(resolveTarget(project, {}), /tracking|upstream|branch/i);
  await assert.rejects(resolveTarget(project, { revision: '--help' }), /revision/i);
});

test('untracked source and alternate tracked config changes do not bypass preflight', async t => {
  const { project } = await repository(t);
  await writeFile(path.join(project, 'new-source.js'), 'uncommitted\n');
  await assert.rejects(inspectSource(project), /dirty|untracked|modified/i);
});

test('normal upgrade fetches first, then fast-forwards only during source selection', async t => {
  const { root, project, next } = await repository(t);
  await git(project, ['switch', 'main']);
  const client = path.join(root, 'client');
  await execute('git', ['clone', '--no-hardlinks', project, client]);
  await git(client, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(project, 'app.txt'), 'third application\n');
  await git(project, ['commit', '-am', 'third']);
  const third = await git(project, ['rev-parse', 'HEAD']);
  const target = await resolveTarget(client);
  assert.equal(target.commit, third);
  assert.equal(target.mode, 'fast-forward');
  assert.equal(await git(client, ['rev-parse', 'HEAD']), next);
  await selectSource(client, target);
  assert.equal(await git(client, ['rev-parse', 'HEAD']), third);
  assert.equal(await git(client, ['branch', '--show-current']), 'main');
  assert.equal((await resolveTarget(client)).commit, third);
});

test('diverged branch is refused without resetting local commits', async t => {
  const { root, project } = await repository(t);
  await git(project, ['switch', 'main']);
  const client = path.join(root, 'client');
  await execute('git', ['clone', '--no-hardlinks', project, client]);
  await git(client, ['config', 'user.name', 'Deployment fixture']);
  await git(client, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(client, 'local.txt'), 'keep local work\n');
  await git(client, ['add', '.']);
  await git(client, ['commit', '-m', 'local']);
  const local = await git(client, ['rev-parse', 'HEAD']);
  await writeFile(path.join(project, 'upstream.txt'), 'upstream work\n');
  await git(project, ['add', '.']);
  await git(project, ['commit', '-m', 'upstream']);
  await assert.rejects(resolveTarget(client), /diverged|fast-forward/i);
  assert.equal(await git(client, ['rev-parse', 'HEAD']), local);
  assert.equal(await readFile(path.join(client, 'local.txt'), 'utf8'), 'keep local work\n');
});
