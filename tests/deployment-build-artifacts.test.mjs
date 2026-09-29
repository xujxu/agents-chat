import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectBuildArtifacts } from '../scripts/deployment/build-artifacts.mjs';

async function fixture(t) {
  const project = path.join(await temporaryDeployment(t), 'app');
  for (const name of ['.next/server', '.next/cache', 'node_modules/example', 'node_modules/.cache']) {
    await mkdir(path.join(project, name), { recursive: true });
  }
  for (const [name, value] of Object.entries({
    'package.json': '{"scripts":{"build":"next build"}}', 'package-lock.json': '{"lockfileVersion":3}',
    '.next/BUILD_ID': 'fixture-build', '.next/server/app.js': 'application',
    'node_modules/example/index.js': 'dependency',
  })) await writeFile(path.join(project, name), value);
  return project;
}

test('build identity binds complete artifacts and dependencies rather than BUILD_ID alone', async t => {
  const project = await fixture(t);
  const captured = await inspectBuildArtifacts({ project });
  assert.equal(captured.identity.buildId, 'fixture-build');
  for (const name of ['build', 'dependencies', 'package', 'lock']) assert.match(captured.identity[name], /^[a-f0-9]{64}$/);
  await captured.check();
  const before = await readFile(path.join(project, '.next/BUILD_ID'));
  await writeFile(path.join(project, '.next/server/app.js'), 'replacement');
  await assert.rejects(captured.check(), /artifact|changed/i);
  assert.deepEqual(await readFile(path.join(project, '.next/BUILD_ID')), before);
  const next = await inspectBuildArtifacts({ project });
  assert.notEqual(next.identity.build, captured.identity.build);
  assert.equal(next.identity.dependencies, captured.identity.dependencies);
  await writeFile(path.join(project, 'node_modules/example/index.js'), 'changed dependency');
  await assert.rejects(next.check(), /artifact|changed/i);
});

test('runtime cache changes do not invalidate build identity but package, lock and file inventory do', async t => {
  const project = await fixture(t);
  const captured = await inspectBuildArtifacts({ project });
  await writeFile(path.join(project, '.next/cache/new'), 'cache');
  await writeFile(path.join(project, 'node_modules/.cache/new'), 'cache');
  await captured.check();
  await writeFile(path.join(project, 'node_modules/example/extra.js'), 'extra');
  await assert.rejects(captured.check(), /artifact|changed/i);
  const changed = await inspectBuildArtifacts({ project });
  await writeFile(path.join(project, 'package-lock.json'), '{"lockfileVersion":2}');
  await assert.rejects(changed.check(), /artifact|changed/i);
});

test('artifact observation refuses missing build identity and respects cancellation', async t => {
  const project = await fixture(t);
  await writeFile(path.join(project, '.next/BUILD_ID'), '');
  await assert.rejects(inspectBuildArtifacts({ project }), /build/i);
  const controller = new AbortController();
  controller.abort(new Error('cancel artifacts'));
  await assert.rejects(inspectBuildArtifacts({ project, signal: controller.signal }), /cancel artifacts/);
});
