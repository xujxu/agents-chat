import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertLockOwner, captureLockOwner } from './state.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { assertWindowsManagedTaskScope } from './windows-managed-task.mjs';
import { assertWindowsTaskSourceStage } from './windows-task-transaction.mjs';
import { prepareOwnedSourceBuild } from './owned-source-build.mjs';

export async function prepareWindowsSourceBuild({
  scope, control, lock: suppliedLock, operation, node, npmCli, git, environment, pwsh, signal,
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || typeof pwsh !== 'string' || !path.isAbsolute(pwsh)
    || path.resolve(pwsh) !== pwsh || /[\0\r\n]/.test(pwsh)) {
    throw new Error('Windows source/build requires explicit native PowerShell.');
  }
  const lock = captureLockOwner(suppliedLock);
  const { root } = await externalWorkerDirectory(control, lock.project);
  await assertLockOwner(root, lock);
  const observation = await assertWindowsManagedTaskScope(scope, { signal });
  if (observation.project !== lock.project) throw new Error('Source task and locked project differ.');
  if (scope.identity.accountSid !== observation.principalSid) {
    throw new Error('Source/build workers require the installed task account; cross-account execution is unsupported.');
  }
  const project = observation.project;
  for (const file of [node, npmCli, git]) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) {
      throw new Error('Source tools require explicit absolute paths.');
    }
    const relative = path.relative(project, await realpath(file));
    if (relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
      throw new Error('Source tools must remain outside the mutable project.');
    }
  }
  const bytes = await readWorkerFile(observation.configuration, 4 * 1024 * 1024, { privateMode: true });
  if (createHash('sha256').update(bytes).digest('hex') !== observation.configurationSha256) {
    throw new Error('Original source runtime configuration changed.');
  }
  const configuration = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (configuration.command.cwd !== project || await realpath(configuration.command.file) !== await realpath(node)) {
    throw new Error('Build Node must match the installed runtime Node.');
  }
  return prepareOwnedSourceBuild({
    project, node, npmCli, operation, git, environment, signal,
    runtime: { pwsh, accountSid: observation.principalSid, sessionId: scope.identity.sessionId },
    checkRead: async ({ signal: stageSignal }) => {
      await assertLockOwner(root, lock);
      await assertWindowsManagedTaskScope(scope, { signal: stageSignal });
    },
    checkMutation: ({ stopped, stage, commit, signal: stageSignal }) =>
      assertWindowsTaskSourceStage({ context: stopped, control: root, lock,
        generation: observation.runtime.generation, stage, commit, signal: stageSignal }),
  });
}
