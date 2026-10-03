import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertLockOwner, captureLockOwner } from './state.mjs';
import { externalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { assertWindowsManagedTaskScope } from './windows-managed-task.mjs';

export async function inspectWindowsWorkerScope({
  scope, control, lock: suppliedLock, node, pwsh, tools = [], signal,
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || typeof pwsh !== 'string' || !path.isAbsolute(pwsh)
    || path.resolve(pwsh) !== pwsh || /[\0\r\n]/.test(pwsh) || !Array.isArray(tools)) {
    throw new Error('Windows workers require explicit native PowerShell and tool paths.');
  }
  const lock = captureLockOwner(suppliedLock);
  const { root } = await externalWorkerDirectory(control, lock.project);
  await assertLockOwner(root, lock);
  const observation = await assertWindowsManagedTaskScope(scope, { signal });
  if (observation.project !== lock.project) throw new Error('Worker task and locked project differ.');
  if (scope.identity.accountSid !== observation.principalSid) {
    throw new Error('Workers require the installed task account; cross-account execution is unsupported.');
  }
  const project = observation.project;
  for (const file of [node, ...tools]) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) {
      throw new Error('Worker tools require explicit absolute paths.');
    }
    const relative = path.relative(project, await realpath(file));
    if (relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
      throw new Error('Worker tools must remain outside the mutable project.');
    }
  }
  const bytes = await readWorkerFile(observation.configuration, 4 * 1024 * 1024, { privateMode: true });
  if (createHash('sha256').update(bytes).digest('hex') !== observation.configurationSha256) {
    throw new Error('Original worker runtime configuration changed.');
  }
  const configuration = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (configuration.command.cwd !== project || await realpath(configuration.command.file) !== await realpath(node)) {
    throw new Error('Worker Node must match the installed runtime Node.');
  }
  const check = async ({ signal: checkSignal = signal } = {}) => {
    checkSignal?.throwIfAborted();
    await assertLockOwner(root, lock);
    await assertWindowsManagedTaskScope(scope, { signal: checkSignal });
  };
  await check();
  return Object.freeze({
    root, lock, observation, check,
    runtime: Object.freeze({ pwsh, accountSid: observation.principalSid, sessionId: scope.identity.sessionId }),
  });
}
