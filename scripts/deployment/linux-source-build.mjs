import { realpath } from 'node:fs/promises';
import { prepareOwnedSourceBuild } from './owned-source-build.mjs';

export async function prepareLinuxSourceBuild({ service, operation, git, environment, signal }) {
  await service.check();
  const { project, uid, gid } = service.identity.runtime;
  return prepareLinuxOwnedSourceBuild({
    project, uid, gid, node: service.identity.executables[1].file,
    npmCli: await realpath(service.identity.executables[0].file), operation, git, environment, signal,
    checkRead: () => service.check(),
    checkMutation: async ({ stopped, signal: stageSignal }) => {
      stageSignal?.throwIfAborted();
      if (typeof stopped?.checkStopped !== 'function') throw new Error('Source/build mutation requires stopped service authority.');
      const state = await stopped.checkStopped();
      if (state?.stopped !== true || state.inhibited !== true) throw new Error('Source/build mutation requires stopped and inhibited service.');
      await service.checkPolicy({ stopped: true, inhibited: true });
    },
  });
}

export async function prepareLinuxOwnedSourceBuild({
  project, uid, gid, node, npmCli, operation, git, environment, signal, checkRead, checkMutation,
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'linux' || typeof operation?.run !== 'function'
    || typeof checkRead !== 'function' || typeof checkMutation !== 'function') {
    throw new Error('Linux source/build stages require an enrolled native operation.');
  }
  return prepareOwnedSourceBuild({
    project, runtime: { uid, gid }, node, npmCli, operation, git, environment, signal, checkRead, checkMutation,
  });
}
