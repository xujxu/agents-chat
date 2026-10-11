import { createHash } from 'node:crypto';
import { assertWindowsManagedTaskScope } from './windows-managed-task.mjs';
import { assertWindowsFirstInstallScope } from './windows-first-install.mjs';
import { openWindowsConfigurationFiles, openWindowsFirstConfigurationFiles } from './windows-configuration-files.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { inspectConfigurationFiles } from './configuration-files.mjs';

const firstConfigurations = new WeakMap();

async function finishInspection(retained, inspected, recheck, signal) {
  const checkFiles = async ({ signal: checkSignal = signal } = {}) => {
    await retained.check({ signal: checkSignal });
    await inspected.check({ signal: checkSignal });
    await retained.check({ signal: checkSignal });
  };
  await recheck();
  await checkFiles({ signal });
  return Object.freeze({
    status: inspected.status, profile: inspected.profile, providers: inspected.providers,
    files: retained.observation.files, projectSecurityDescriptor: retained.observation.projectSecurityDescriptor,
    projectFileSecurityDescriptor: retained.observation.projectFileSecurityDescriptor,
    checkFiles, buildEnvironment: inspected.buildEnvironment, startupEnvironment: inspected.startupEnvironment,
    close: () => retained.close(),
  });
}

export async function inspectWindowsConfiguration({ scope, pwsh, profile, signal }) {
  const observed = await assertWindowsManagedTaskScope(scope, { signal });
  const retained = await openWindowsConfigurationFiles({
    project: observed.project, configuration: observed.configuration, sha256: observed.configurationSha256, pwsh, signal,
  });
  try {
    const bytes = await readWorkerFile(observed.configuration, 1024 * 1024, { privateMode: true });
    if (createHash('sha256').update(bytes).digest('hex') !== observed.configurationSha256) {
      throw new Error('Installed configuration digest changed.');
    }
    const configuration = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (configuration.command.cwd !== observed.project) throw new Error('Installed configuration project changed.');
    const inspected = await inspectConfigurationFiles({
      project: observed.project, profile, environment: configuration.command.environment, signal,
    });
    return await finishInspection(retained, inspected, () => assertWindowsManagedTaskScope(scope, { signal }), signal);
  } catch (error) {
    try { await retained.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Configuration inspection and close failed.'); }
    throw error;
  }
}

export async function inspectWindowsFirstConfiguration({ scope, pwsh, profile, signal }) {
  const observed = await assertWindowsFirstInstallScope(scope, { signal });
  const retained = await openWindowsFirstConfigurationFiles({ project: observed.project, pwsh, signal });
  try {
    if (retained.observation.projectSecurityDescriptor !== observed.projectSecurityDescriptor) {
      throw new Error('Original first-install project permissions changed.');
    }
    const inspected = await inspectConfigurationFiles({
      project: observed.project, profile, environment: { NODE_ENV: 'production' }, signal,
    });
    inspected.buildEnvironment({});
    const configuration = await finishInspection(retained, inspected, () => assertWindowsFirstInstallScope(scope, { signal }), signal);
    firstConfigurations.set(configuration, scope);
    return configuration;
  } catch (error) {
    try { await retained.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Configuration inspection and close failed.'); }
    throw error;
  }

}

export async function assertWindowsFirstConfiguration(configuration, { scope, signal }) {
  if (!scope || firstConfigurations.get(configuration) !== scope) {
    throw new Error('Original first-install configuration and scope are required.');
  }
  await configuration.checkFiles({ signal });
  return configuration;
}
