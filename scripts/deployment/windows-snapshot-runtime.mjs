import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { verifySnapshot } from './snapshot.mjs';
import { relativeSnapshotPath } from './snapshot-files.mjs';
import { canonicalWorkerDirectory, readWorkerFile } from './worker-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';

const canonical = value => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
const inside = (parent, file) => {
  const relative = path.relative(parent, file);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function inspectWindowsSnapshotRuntime({ backup, snapshot, project, taskName, signal }) {
  signal?.throwIfAborted();
  if (!canonical(project) || typeof taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(taskName)) {
    throw new Error('Saved Windows runtime inspection requires an explicit canonical project and task.');
  }
  const { root } = await canonicalWorkerDirectory(backup, { privateMode: true });
  if (inside(project, root) || inside(root, project)) throw new Error('Saved runtime backup must be outside the project.');
  const original = await verifySnapshot(root, { signal });
  if (!same(original, snapshot) || original.version !== 3 || original.scope !== 'project'
    || original.project !== project || original.runtime.platform !== 'win32') {
    throw new Error('Saved runtime inspection requires the matching complete Windows snapshot.');
  }
  const task = Object.freeze(captureWorkerFields(original.runtime.task, [
    'version', 'name', 'definition', 'securityDescriptor', 'configuration', 'configurationSha256',
  ], 'saved Windows task'));
  if (task.version !== 1 || task.name !== taskName || !canonical(task.configuration)
    || path.basename(task.configuration) !== 'configuration.json'
    || typeof task.configurationSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(task.configurationSha256)
    || typeof task.definition !== 'string' || !task.definition || task.definition.length > 262144 || task.definition.includes('\0')
    || typeof task.securityDescriptor !== 'string' || !task.securityDescriptor
    || task.securityDescriptor.length > 65536 || /[\0\r\n]/.test(task.securityDescriptor)) {
    throw new Error('Saved runtime task metadata differs from the requested installation.');
  }
  const member = async (name, originalFile, sha256) => {
    signal?.throwIfAborted();
    let entry;
    let file;
    if (inside(project, originalFile)) {
      const relative = path.relative(project, originalFile);
      entry = original.entries.find(value => value.path === relative.split(path.sep).join('/'));
      file = path.join(root, 'files', relative);
    } else {
      const index = (original.externalFiles ?? []).findIndex(value => value.path === originalFile);
      entry = original.externalFiles?.[index];
      file = path.join(root, 'external', String(index));
    }
    if (entry?.kind !== 'file' || entry.sha256 !== sha256 || entry.bytes > 1024 * 1024) {
      throw new Error('Saved runtime member is absent, oversized or differs from its declared digest.');
    }
    const bytes = await readWorkerFile(file, 1024 * 1024, { privateMode: true });
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new Error('Saved runtime member changed during inspection.');
    }
    return { bytes, record: Object.freeze({ name, file, sha256 }) };
  };
  const configurationFile = await member('configuration.json', task.configuration, task.configurationSha256);
  const configuration = captureWorkerFields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configurationFile.bytes)),
    ['version', 'helpers', 'command'], 'saved runtime configuration');
  if (configuration.version !== 1 || configuration.command?.cwd !== project
    || !configuration.helpers || typeof configuration.helpers !== 'object' || Array.isArray(configuration.helpers)) {
    throw new Error('Saved runtime configuration does not describe the original project.');
  }
  const helpers = Object.entries(configuration.helpers);
  if (!helpers.length || helpers.length > 63) throw new Error('Unsupported saved runtime helper inventory.');
  const names = new Set(['configuration.json']);
  const files = [configurationFile.record];
  for (const [name, sha256] of helpers) {
    relativeSnapshotPath(name);
    if (name.length > 255 || name.includes('/') || names.has(name.toLowerCase())
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('Unsupported or duplicate saved runtime helper name or digest.');
    }
    names.add(name.toLowerCase());
    files.push((await member(name, path.join(path.dirname(task.configuration), name), sha256)).record);
  }
  const check = async ({ signal: checkSignal = signal } = {}) => {
    checkSignal?.throwIfAborted();
    if (!same(await verifySnapshot(root, { signal: checkSignal }), original)) {
      throw new Error('Saved runtime snapshot changed after inspection.');
    }
  };
  await check();
  Object.freeze(configuration.helpers);
  Object.freeze(configuration.command);
  return Object.freeze({ task, configuration: Object.freeze(configuration), files: Object.freeze(files), check });
}
