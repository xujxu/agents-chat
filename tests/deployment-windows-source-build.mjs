import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { saveWorkerEngine } from '../scripts/deployment/saved-worker-engine.mjs';
import { saveRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';
import { createWorkerOperation } from '../scripts/deployment/worker-operation.mjs';

export async function createWindowsSourceFixture({ project, control, lock, pwsh, tools }) {
  const { prepareWindowsSourceBuild } = await import('../scripts/deployment/windows-source-build.mjs');
  const git = async args => {
    const result = await promisify(execFile)(tools.git, ['-C', project, ...args], {
      env: tools.environment, timeout: 30000, maxBuffer: 65536,
    });
    return result.stdout.trim();
  };
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Deployment fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(project, '.gitignore'),
    '*\n!.gitignore\n!package.json\n!package-lock.json\n!fixture-build.cjs\n!source-marker.txt\n');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({
    name: 'owned-source-fixture', version: '1.0.0', private: true, scripts: { build: 'node fixture-build.cjs' },
  }));
  await writeFile(path.join(project, 'package-lock.json'), JSON.stringify({
    name: 'owned-source-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'owned-source-fixture', version: '1.0.0' } },
  }));
  await writeFile(path.join(project, 'fixture-build.cjs'), `
const fs = require('node:fs');
fs.mkdirSync('node_modules', { recursive: true });
fs.mkdirSync('.next', { recursive: true });
fs.writeFileSync('.next/BUILD_ID', fs.readFileSync('source-marker.txt', 'utf8').trim());
`);
  await writeFile(path.join(project, 'source-marker.txt'), 'old-source\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'old fixture']);
  const beforeCommit = await git(['rev-parse', 'HEAD']);
  await writeFile(path.join(project, 'source-marker.txt'), 'new-source\n');
  await git(['commit', '-am', 'new fixture']);
  const targetCommit = await git(['rev-parse', 'HEAD']);
  await git(['switch', '--detach', beforeCommit]);
  let workers;
  let stages;
  let target;
  let built;
  return {
    beforeCommit, targetCommit,
    get operation() { return workers; },
    async prepare(scope) {
      const observedSession = await promisify(execFile)(pwsh, [
        '-NoProfile', '-NonInteractive', '-Command', '[Diagnostics.Process]::GetCurrentProcess().SessionId',
      ], { timeout: 30000, maxBuffer: 4096 });
      assert.equal(scope.identity.sessionId, Number(observedSession.stdout.trim()));
      assert.equal(scope.identity.accountSid, scope.observation.principalSid);
      assert.equal(scope.observation.runtime.sessionId, 0);
      const source = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));
      const saved = await saveWorkerEngine({ source, control, project, operationId: lock.operationId });
      await saveRecoveryEngine({ source, control });
      workers = await createWorkerOperation({ control, lock, saved });
      const options = { scope, control, lock, operation: workers, pwsh, ...tools };
      await assert.rejects(prepareWindowsSourceBuild({ ...options, scope: { ...scope } }));
      stages = await prepareWindowsSourceBuild(options);
      assert.equal((await stages.inspect()).commit, beforeCommit);
      target = await stages.resolve({ options: { revision: targetCommit } });
      assert.equal(target.commit, targetCommit);
      assert.equal(await git(['rev-parse', 'HEAD']), beforeCommit);
      await assert.rejects(stages.select({ target, stopped: { check: async () => {} } }));
    },
    async refuseEarly(context) {
      await assert.rejects(stages.select({ target, stopped: { ...context } }));
      await assert.rejects(stages.select({ target, stopped: context }));
      assert.equal(await git(['rev-parse', 'HEAD']), beforeCommit);
    },
    async refuseActive(context) {
      await context.check();
      await assert.rejects(stages.npm({ stage: 'build', commit: targetCommit, stopped: context }));
      await built.artifacts.check();
    },
    async advance(phase, context) {
      if (phase === 'source-selected') {
        assert.equal((await stages.select({ target, stopped: context })).commit, targetCommit);
      } else if (phase === 'dependencies') {
        await stages.npm({ stage: 'dependencies', commit: targetCommit, stopped: context });
      } else if (phase === 'building') {
        await assert.rejects(stages.npm({ stage: 'build', commit: beforeCommit, stopped: context }));
        built = await stages.npm({ stage: 'build', commit: targetCommit, stopped: context });
        assert.equal(built.sourceCommit, targetCommit);
        assert.equal(built.artifacts.identity.buildId, 'new-source');
        await built.artifacts.check();
      } else if (phase === 'configuring') {
        await assert.rejects(stages.npm({ stage: 'build', commit: targetCommit, stopped: context }));
        await built.artifacts.check();
        assert.equal(await readFile(path.join(project, 'source-marker.txt'), 'utf8'), 'new-source\n');
        await workers.seal();
      }
    },
  };
}
