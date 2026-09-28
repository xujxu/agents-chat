import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { inspectConfigurationFiles } from './configuration-files.mjs';
import { linuxSystemdBus as bus, linuxSystemdProperties } from './linux-systemd.mjs';

function refusal(check) {
  return Object.assign(new Error(`Configuration compatibility refused: ${check}.`), {
    code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED', check,
    nextAction: 'Inspect the original service environment policy and retained source files without printing credentials.',
  });
}

function environment(entries) {
  if (!Array.isArray(entries) || entries.length > 4096) throw refusal('runtime-environment');
  const result = Object.create(null);
  for (const entry of entries) {
    if (typeof entry !== 'string') throw refusal('runtime-environment');
    const index = entry.indexOf('=');
    const key = entry.slice(0, index);
    if (index <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      || Object.hasOwn(result, key) || /[\0\r\n]/.test(entry)) throw refusal('runtime-environment');
    result[key] = entry.slice(index + 1);
  }
  return result;
}

async function startupEnvironment(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw refusal('runtime-process');
  const handle = await open(`/proc/${pid}/environ`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let total = 0;
    while (total < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (!total || total === bytes.length || bytes[total - 1] !== 0) throw refusal('runtime-environment');
    return environment(new TextDecoder('utf-8', { fatal: true })
      .decode(bytes.subarray(0, total - 1)).split('\0'));
  } finally { await handle.close(); }
}

async function configuration(unit) {
  const object = await bus(['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'GetUnit', 's', unit], 'o');
  if (typeof object !== 'string' || !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(object)) {
    throw refusal('runtime-unit');
  }
  const property = (name, signature) => bus(['get-property', 'org.freedesktop.systemd1', object,
    'org.freedesktop.systemd1.Service', name], signature);
  const [values, files, pass, unset, policy] = await Promise.all([
    property('Environment', 'as'), property('EnvironmentFiles', 'a(sb)'),
    property('PassEnvironment', 'as'), property('UnsetEnvironment', 'as'),
    linuxSystemdProperties(unit, ['PAMName']),
  ]);
  if (pass.length || unset.length || policy.PAMName) throw refusal('runtime-environment-policy');
  if (files.length > 32 || files.some(file => !Array.isArray(file) || file.length !== 2
    || typeof file[0] !== 'string' || !path.isAbsolute(file[0]) || path.resolve(file[0]) !== file[0]
    || /[\0\r\n*?[\]]/.test(file[0]) || typeof file[1] !== 'boolean')) {
    throw refusal('runtime-environment-files');
  }
  return { environment: environment(values), systemdFiles: files.map(([file, optional]) => ({ path: file, optional })) };
}

export async function inspectLinuxConfiguration({ service, profile, signal }) {
  try {
    signal?.throwIfAborted();
    await service.check();
    const { unit, project, mainPid } = service.identity.runtime;
    const config = await configuration(unit);
    const observedEnvironment = await startupEnvironment(mainPid, signal);
    const files = await inspectConfigurationFiles({ project, profile, ...config, observedEnvironment, signal });
    const check = async () => {
      try {
        signal?.throwIfAborted();
        await service.check();
        if (!same(await configuration(unit), config)
          || !same(await startupEnvironment(mainPid, signal), observedEnvironment)) {
          throw refusal('runtime-environment-changed');
        }
        await files.check();
        await service.check();
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.code === 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED') throw error;
        throw refusal('runtime-configuration-changed');
      }
    };
    await check();
    return Object.freeze({ ...files, check });
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED') throw error;
    throw refusal('runtime-configuration-inspection');
  }
}
