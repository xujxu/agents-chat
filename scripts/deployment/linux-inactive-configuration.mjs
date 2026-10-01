import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { inspectConfigurationFiles } from './configuration-files.mjs';
import { inspectLinuxConfigurationPolicy, parseLinuxEnvironment } from './linux-configuration.mjs';
import { linuxSystemdBus as bus } from './linux-systemd.mjs';

function refusal(check) {
  return Object.assign(new Error(`Configuration compatibility refused: ${check}.`), {
    code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED', check,
    nextAction: 'Inspect retained unit/EnvironmentFile assignments and systemd global environment without printing credentials.',
  });
}

async function managerPolicy(unit) {
  const object = await bus(['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'LoadUnit', 's', unit], 'o');
  if (typeof object !== 'string' || !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(object)) {
    throw refusal('inactive-runtime-unit');
  }
  const [environment, searchPath] = await Promise.all([
    bus(['get-property', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager', 'Environment'], 'as'),
    bus(['get-property', 'org.freedesktop.systemd1', object,
      'org.freedesktop.systemd1.Service', 'ExecSearchPath'], 'as'),
  ]);
  if (!Array.isArray(searchPath) || searchPath.length > 128
    || searchPath.some(value => typeof value !== 'string' || !value || /[\0\r\n]/.test(value))) {
    throw refusal('inactive-runtime-path');
  }
  return { environment: parseLinuxEnvironment(environment), searchPath };
}

function runtimePath(startup, manager) {
  const value = startup.PATH ?? (manager.searchPath.length ? manager.searchPath.join(':') : manager.environment.PATH);
  if (typeof value !== 'string' || !value || value.length > 16384) throw refusal('inactive-runtime-path');
  const entries = value.split(':');
  if (entries.length > 128 || entries.some(entry => !path.isAbsolute(entry) || path.resolve(entry) !== entry)) {
    throw refusal('inactive-runtime-path');
  }
  return Object.freeze(entries);
}

export async function inspectLinuxInactiveConfiguration({ service, profile, signal }) {
  try {
    signal?.throwIfAborted();
    if (service.kind !== 'inactive' || service.identity.runtime.mainPid !== 0) {
      throw refusal('inactive-runtime');
    }
    await service.check();
    const { unit, project } = service.identity.runtime;
    const config = await inspectLinuxConfigurationPolicy(unit);
    const manager = await managerPolicy(unit);
    const files = await inspectConfigurationFiles({ project, profile, ...config, signal });
    const startup = files.startupEnvironment();
    if (Object.keys(manager.environment).some(name => !Object.hasOwn(startup, name)
      && !['PATH', 'LANG', 'LANGUAGE'].includes(name) && !/^LC_[A-Z_]+$/.test(name))) {
      throw refusal('inactive-manager-environment');
    }
    const searchPath = runtimePath(startup, manager);
    const checkFiles = async ({ signal: checkSignal = signal } = {}) => {
      try {
        checkSignal?.throwIfAborted();
        if (!same(await inspectLinuxConfigurationPolicy(unit), config) || !same(await managerPolicy(unit), manager)) {
          throw refusal('inactive-environment-changed');
        }
        await files.check({ signal: checkSignal });
        checkSignal?.throwIfAborted();
      } catch (error) {
        checkSignal?.throwIfAborted();
        if (error?.code === 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED') throw error;
        throw refusal('inactive-configuration-changed');
      }
    };
    const check = async ({ signal: checkSignal = signal } = {}) => {
      try {
        checkSignal?.throwIfAborted();
        await service.check();
        await checkFiles({ signal: checkSignal });
        await service.check();
      } catch (error) {
        checkSignal?.throwIfAborted();
        if (error?.code === 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED') throw error;
        throw refusal('inactive-configuration-changed');
      }
    };
    await check();
    return Object.freeze({ ...files, checkFiles, check, runtimePath: () => searchPath });
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED') throw error;
    throw refusal('inactive-configuration-inspection');
  }
}
