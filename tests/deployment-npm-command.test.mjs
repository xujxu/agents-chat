import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { prepareNpmCommand } from '../scripts/deployment/npm-command.mjs';

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'source with spaces');
  await mkdir(project);
  const npmCli = path.join(root, 'npm-cli.js');
  await writeFile(npmCli, '// command fixture\n');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { build: 'next build' } }));
  await writeFile(path.join(project, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  return { project, node: process.execPath, npmCli, environment: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' } };
}

test('dependency and build commands use explicit Node/npm paths without a shell or implicit build installation', async t => {
  const f = await fixture(t);
  const dependencies = await prepareNpmCommand({ ...f, stage: 'dependencies' });
  assert.equal(dependencies.file, process.execPath);
  assert.deepEqual(dependencies.args, [f.npmCli, 'ci', '--include=dev', '--no-audit', '--no-fund']);
  assert.equal(dependencies.cwd, f.project);
  assert.equal(dependencies.env.NODE_ENV, 'production');
  assert.equal(dependencies.env.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
  const build = await prepareNpmCommand({ ...f, stage: 'build' });
  assert.deepEqual(build.args, [f.npmCli, 'run', 'build']);
  assert.equal(Object.isFrozen(build), true);
  assert.equal(Object.isFrozen(build.env), true);
});

test('unsupported npm stages, missing lockfile and absent build script refuse before execution', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareNpmCommand({ ...f, stage: 'start' }), /stage/i);
  await assert.rejects(prepareNpmCommand({ ...f, stage: 'build', node: 'node' }), /absolute/i);
  await writeFile(path.join(f.project, 'package.json'), '{}');
  await assert.rejects(prepareNpmCommand({ ...f, stage: 'build' }), /build/i);
  await writeFile(path.join(f.project, 'package-lock.json'), '{}');
  await assert.rejects(prepareNpmCommand({ ...f, stage: 'dependencies' }), /lock/i);
  await assert.rejects(prepareNpmCommand({ ...f, stage: 'dependencies',
    environment: { NODE_OPTIONS: '--import=untrusted.mjs' } }), /environment/i);
  const controller = new AbortController();
  controller.abort(new Error('cancel npm preparation'));
  await assert.rejects(prepareNpmCommand({ ...f, stage: 'build', signal: controller.signal }), /cancel npm/);
});
