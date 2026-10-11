import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { assertWindowsManagedTaskScope } from './windows-managed-task.mjs';
import { inspectWindowsConfiguration } from './windows-configuration.mjs';
import { inspectWindowsSnapshotRuntime } from './windows-snapshot-runtime.mjs';
import { inspectWindowsRestoreTaskPolicy } from './windows-restore-task-policy.mjs';
import { inspectSnapshotConfiguration } from './snapshot-configuration.mjs';
import { canonicalWorkerDirectory } from './worker-files.mjs';
import { verifySnapshot } from './snapshot.mjs';

const inside = (parent, file) => {
  const relative = path.relative(parent, file);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function admitWindowsRestore({ scope, backup, snapshot, node, pwsh, profile, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![node, pwsh].every(file =>
    typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file && !/[\0\r\n]/.test(file))) {
    throw new Error('Windows restore admission requires explicit canonical native executables.');
  }
  const observed = await assertWindowsManagedTaskScope(scope, { signal });
  const project = observed.project;
  if (scope.identity.accountSid !== observed.principalSid || inside(project, await realpath(node))
    || inside(project, await realpath(pwsh))) {
    throw new Error('Windows restore requires the installed account and external native executables.');
  }
  const { root } = await canonicalWorkerDirectory(backup, { privateMode: true });
  const original = await verifySnapshot(root, { signal });
  if (!same(original, snapshot)) throw new Error('Expected Windows restore snapshot changed.');
  const runtime = await inspectWindowsSnapshotRuntime({
    project, backup: root, snapshot: original, taskName: observed.taskName, signal,
  });
  if (typeof runtime.configuration.command.file !== 'string'
    || !path.isAbsolute(runtime.configuration.command.file)
    || await realpath(runtime.configuration.command.file) !== await realpath(node)) {
    throw new Error('Archived runtime Node differs from the explicit restore executable.');
  }
  await inspectWindowsRestoreTaskPolicy({ scope, task: runtime.task, pwsh, signal });
  const current = await inspectWindowsConfiguration({ scope, pwsh, profile, signal });
  try {
    if (original.windowsSecurity.descriptors[original.windowsSecurity.root.security] !== current.projectSecurityDescriptor) {
      throw new Error('Restoring changed project security requires a separate native policy transition.');
    }
    const paths = [
      ...runtime.files.map(file => path.join(path.dirname(runtime.task.configuration), file.name)),
      ...current.files.map(file => file.path),
    ].filter(file => !inside(project, file));
    const authorizedPaths = Object.freeze([...new Set(paths)].sort());
    if (!same(authorizedPaths, (original.externalFiles ?? []).map(file => file.path).sort())) {
      throw new Error('Archived external destinations differ from original task and configuration authority.');
    }
    const configuration = await inspectSnapshotConfiguration({
      backup: root, snapshot: original, profile, environment: runtime.configuration.command.environment, signal,
    });
    const checkSnapshot = async ({ signal: checkSignal = signal } = {}) => {
      checkSignal?.throwIfAborted();
      await runtime.check({ signal: checkSignal });
      await configuration.check({ signal: checkSignal });
    };
    const check = async ({ signal: checkSignal = signal } = {}) => {
      checkSignal?.throwIfAborted();
      if (!same(await assertWindowsManagedTaskScope(scope, { signal: checkSignal }), observed)) {
        throw new Error('Original restore task observation changed.');
      }
      await current.checkFiles({ signal: checkSignal });
      await checkSnapshot({ signal: checkSignal });
      await current.checkFiles({ signal: checkSignal });
      await assertWindowsManagedTaskScope(scope, { signal: checkSignal });
    };
    await check({ signal });
    return Object.freeze({
      snapshot: original, runtime, providers: configuration.providers, configurationProfile: configuration.profile,
      authorizedPaths, check, checkSnapshot, close: () => current.close(),
    });
  } catch (error) {
    try { await current.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Windows restore admission and native configuration cleanup failed.'); }
    throw error;
  }
}
