import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { captureSourceCommands, readSourceCommandResult } from './source-command.mjs';
import { prepareNpmCommand } from './npm-command.mjs';
import { captureWorkerCommand } from './worker-wire.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { inspectGitMetadata } from './git-metadata.mjs';
import { inspectBuildArtifacts } from './build-artifacts.mjs';
import { readWorkerFile } from './worker-files.mjs';

export async function prepareOwnedSourceBuild({
  project, runtime: suppliedRuntime, node, npmCli, operation, git, environment, signal, checkRead, checkMutation,
}) {
  signal?.throwIfAborted();
  if (!['linux', 'win32'].includes(process.platform) || typeof operation?.run !== 'function'
    || typeof checkRead !== 'function' || typeof checkMutation !== 'function') {
    throw new Error('Source/build stages require an enrolled native operation and authority checks.');
  }
  const runtime = captureWorkerFields(suppliedRuntime,
    process.platform === 'win32' ? ['pwsh', 'accountSid', 'sessionId'] : ['uid', 'gid'], 'source worker runtime');
  await checkRead({ signal });
  const env = captureWorkerCommand({ file: node, args: [], cwd: project, env: environment }).env;
  const source = await captureSourceCommands({ project, node, git, environment: env, signal });
  await checkRead({ signal });
  const run = (command, stageSignal) => operation.run({
    workerId: randomUUID(), runtime, command, signal: stageSignal,
  });
  return Object.freeze({
    async inspect({ signal: stageSignal } = {}) {
      await checkRead({ signal: stageSignal });
      const output = await run(source.prepare({ action: 'inspect', signal: stageSignal }), stageSignal);
      await checkRead({ signal: stageSignal });
      return readSourceCommandResult(output, 'inspect', project);
    },
    async resolve({ options = {}, signal: stageSignal } = {}) {
      await checkRead({ signal: stageSignal });
      const output = await run(source.prepare({ action: 'resolve', options, signal: stageSignal }), stageSignal);
      await checkRead({ signal: stageSignal });
      return readSourceCommandResult(output, 'resolve', project);
    },
    async select({ target, stopped, signal: stageSignal }) {
      const check = () => checkMutation({ stopped, signal: stageSignal, stage: 'select', commit: target.commit });
      await check();
      const command = source.prepare({ action: 'select', options: target, signal: stageSignal });
      await check();
      const output = await run(command, stageSignal);
      await check();
      const result = readSourceCommandResult(output, 'select', project);
      if (result.commit !== target.commit) throw new Error('Selected source differs from admitted target.');
      return result;
    },
    async npm({ stage, commit, stopped, environment: npmEnvironment = env, signal: stageSignal }) {
      const check = () => checkMutation({ stopped, signal: stageSignal, stage, commit });
      await check();
      if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
        throw new Error('Build requires the exact selected source commit.');
      }
      const before = await inspectGitMetadata({ project, commit, signal: stageSignal });
      const inputs = await Promise.all(['package.json', 'package-lock.json'].map(async name => ({
        file: path.join(project, name), bytes: await readWorkerFile(path.join(project, name), 16 * 1024 * 1024),
      })));
      const command = await prepareNpmCommand({
        project, node, npmCli, stage, environment: npmEnvironment, signal: stageSignal,
      });
      await before.check();
      await check();
      const output = await run(command, stageSignal);
      await before.check();
      await check();
      const inspected = readSourceCommandResult(await run(source.prepare({
        action: 'inspect', signal: stageSignal,
      }), stageSignal), 'inspect', project);
      if (inspected.commit !== commit) throw new Error('Build changed the selected source commit.');
      for (const input of inputs) {
        if (!(await readWorkerFile(input.file, 16 * 1024 * 1024)).equals(input.bytes)) {
          throw new Error('npm execution changed the admitted package or lock file.');
        }
      }
      const artifacts = stage === 'build' ? await inspectBuildArtifacts({ project, signal: stageSignal }) : undefined;
      await check();
      return stage === 'build' ? Object.freeze({ output, sourceCommit: commit, source: before, artifacts }) : output;
    },
  });
}
