import { createHash } from 'node:crypto';
import { assertWindowsManagedTaskScope } from './windows-managed-task.mjs';
import { openWindowsConfigurationFiles } from './windows-configuration-files.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { inspectConfigurationFiles } from './configuration-files.mjs';

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
    const checkFiles = async ({ signal: checkSignal = signal } = {}) => {
      await retained.check({ signal: checkSignal });
      await inspected.check({ signal: checkSignal });
      await retained.check({ signal: checkSignal });
    };
    await assertWindowsManagedTaskScope(scope, { signal });
    await checkFiles({ signal });
    return Object.freeze({
      status: inspected.status, profile: inspected.profile, providers: inspected.providers,
      files: retained.observation.files, projectSecurityDescriptor: retained.observation.projectSecurityDescriptor,
      checkFiles, buildEnvironment: inspected.buildEnvironment, startupEnvironment: inspected.startupEnvironment,
      close: () => retained.close(),
    });
  } catch (error) {
    try { await retained.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Configuration inspection and close failed.'); }
    throw error;
  }
}
