import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureSourceCommands, readSourceCommandResult } from './source-command.mjs';
import { prepareNpmCommand } from './npm-command.mjs';
import { captureWorkerCommand } from './worker-wire.mjs';
import { inspectGitMetadata } from './git-metadata.mjs';
import { inspectBuildArtifacts } from './build-artifacts.mjs';
import { readWorkerFile } from './worker-files.mjs';

export async function prepareLinuxSourceBuild({ service, operation, git, environment, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'linux' || typeof operation?.run !== 'function') {
    throw new Error('Linux source/build stages require an enrolled native operation.');
  }
  await service.check();
  const { project, uid, gid } = service.identity.runtime;
  const node = service.identity.executables[1].file;
  const npmCli = await realpath(service.identity.executables[0].file);
  const env = captureWorkerCommand({ file: node, args: [], cwd: project, env: environment }).env;
  const source = await captureSourceCommands({ project, node, git, environment: env, signal });
  await service.check();
  const checkStopped = async (stopped, stageSignal) => {
    stageSignal?.throwIfAborted();
    if (typeof stopped?.checkStopped !== 'function') throw new Error('Source/build mutation requires stopped service authority.');
    const state = await stopped.checkStopped();
    if (state?.stopped !== true || state.inhibited !== true) throw new Error('Source/build mutation requires stopped and inhibited service.');
    await service.checkPolicy({ stopped: true, inhibited: true });
  };
  const run = (command, stageSignal) => operation.run({
    workerId: randomUUID(), runtime: { uid, gid }, command, signal: stageSignal,
  });
  return Object.freeze({
    async inspect({ signal: stageSignal } = {}) {
      await service.check();
      const output = await run(source.prepare({ action: 'inspect', signal: stageSignal }), stageSignal);
      await service.check();
      return readSourceCommandResult(output, 'inspect', project);
    },
    async resolve({ options = {}, signal: stageSignal } = {}) {
      await service.check();
      const output = await run(source.prepare({ action: 'resolve', options, signal: stageSignal }), stageSignal);
      await service.check();
      return readSourceCommandResult(output, 'resolve', project);
    },
    async select({ target, stopped, signal: stageSignal }) {
      await checkStopped(stopped, stageSignal);
      const command = source.prepare({ action: 'select', options: target, signal: stageSignal });
      await checkStopped(stopped, stageSignal);
      const output = await run(command, stageSignal);
      await checkStopped(stopped, stageSignal);
      const result = readSourceCommandResult(output, 'select', project);
      if (result.commit !== target.commit) throw new Error('Selected source differs from admitted target.');
      return result;
    },
    async npm({ stage, commit, stopped, signal: stageSignal }) {
      await checkStopped(stopped, stageSignal);
      if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
        throw new Error('Build requires the exact selected source commit.');
      }
      const before = await inspectGitMetadata({ project, commit, signal: stageSignal });
      const inputs = await Promise.all(['package.json', 'package-lock.json'].map(async name => ({
        file: path.join(project, name), bytes: await readWorkerFile(path.join(project, name), 16 * 1024 * 1024),
      })));
      const command = await prepareNpmCommand({
        project, node, npmCli, stage, environment: env, signal: stageSignal,
      });
      await before.check();
      await checkStopped(stopped, stageSignal);
      const output = await run(command, stageSignal);
      await before.check();
      await checkStopped(stopped, stageSignal);
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
      await checkStopped(stopped, stageSignal);
      return stage === 'build' ? Object.freeze({ output, sourceCommit: commit, source: before, artifacts }) : output;
    },
  });
}
