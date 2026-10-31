import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { inspectLinuxInactiveConfigurationFiles } from './linux-inactive-configuration.mjs';
import { inspectLinuxInactiveService } from './linux-inactive-service.mjs';
import { inspectLinuxServiceExecutable } from './linux-service-inspection.mjs';

const outside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};

async function inspectNpm(npm) {
  const executable = await inspectLinuxServiceExecutable(npm);
  const handle = await open(executable.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] !== '#!/usr/bin/env node') {
      throw new Error('Inactive discovery requires the supported npm Node interpreter.');
    }
  } finally { await handle.close(); }
  if (!same(await inspectLinuxServiceExecutable(npm), executable)) throw new Error('npm executable changed during discovery.');
  return executable;
}

async function resolveNode(entries, project) {
  for (const directory of entries) {
    const file = path.join(directory, 'node');
    let info;
    try { info = await stat(file); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      throw error;
    }
    if (!info.isFile() || !(info.mode & 0o111)) continue;
    const executable = await inspectLinuxServiceExecutable(file);
    if (!outside(project, file) || !outside(project, executable.target)) {
      throw new Error('Inactive discovery requires an external Node runtime, not a project-local PATH candidate.');
    }
    return executable;
  }
  throw new Error('Inactive discovery found no executable Node runtime in the retained service PATH.');
}

export async function inspectInstalledLinuxInactiveService({ runtime, npm, signal }) {
  let service;
  try {
    signal?.throwIfAborted();
    const { unit, project } = runtime;
    const configuration = await inspectLinuxInactiveConfigurationFiles({
      unit, project, profile: 'agents-chat-auth-638c553', signal,
    });
    const interpreter = await inspectNpm(npm);
    const node = await resolveNode(configuration.runtimePath(), project);
    service = await inspectLinuxInactiveService({ unit, project, npm, node: node.target, signal });
    if (!same(service.identity.runtime, runtime)) throw new Error('Inactive runtime changed during executable discovery.');
    const checkDiscovery = async () => {
      signal?.throwIfAborted();
      await configuration.checkFiles();
      if (!same(await inspectNpm(npm), interpreter)
        || !same(await resolveNode(configuration.runtimePath(), project), node)) {
        throw new Error('Inactive runtime executable resolution changed.');
      }
    };
    const guard = method => async (...args) => {
      await checkDiscovery();
      const result = await method(...args);
      await checkDiscovery();
      return result;
    };
    const observed = Object.freeze({
      ...service, check: guard(service.check), checkPolicy: guard(service.checkPolicy),
      checkInhibited: guard(service.checkInhibited),
    });
    await observed.check();
    return observed;
  } catch (error) {
    try { await service?.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Inactive executable discovery and cleanup failed.'); }
    throw error;
  }
}
