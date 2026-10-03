import { randomUUID } from 'node:crypto';
import { inspectWindowsWorkerScope } from './windows-worker-scope.mjs';
import { inspectWindowsConfiguration } from './windows-configuration.mjs';
import { inspectTargetCompatibility } from './target-compatibility.mjs';
import { prepareDatabaseInspectionCommand, readDatabaseInspectionResult } from './database-command.mjs';

export async function admitWindowsCompatibility({
  scope, control, lock, operation, node, git, pwsh, commit, signal,
}) {
  const authority = await inspectWindowsWorkerScope({
    scope, control, lock, node, pwsh, tools: [git], signal,
  });
  const project = authority.observation.project;
  const environment = { SystemRoot: process.env.SystemRoot };
  const run = async (command, checkSignal = signal) => {
    await authority.check({ signal: checkSignal });
    const result = await operation.run({
      workerId: randomUUID(), command, runtime: authority.runtime, signal: checkSignal,
    });
    await authority.check({ signal: checkSignal });
    return result;
  };
  const version = await run({ file: node, args: ['--version'], cwd: project, env: environment });
  const match = typeof version.stdout === 'string' && version.stdout.length <= 64 && version.stderr === ''
    ? version.stdout.match(/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\r?\n?$/) : null;
  if (!match || match[0] !== version.stdout) {
    throw Object.assign(new Error('Runtime compatibility refused: node-version-output.'), {
      code: 'DEPLOYMENT_RUNTIME_UNSUPPORTED', check: 'node-version-output',
    });
  }
  const runtime = Object.freeze({ status: 'runtime-observed', platform: 'win32', nodeVersion: match[1] });
  const target = await inspectTargetCompatibility({
    project, commit, git, nodeVersion: runtime.nodeVersion, platform: runtime.platform, signal,
  });
  const configuration = await inspectWindowsConfiguration({
    scope, pwsh, profile: target.configurationProfile, signal,
  });
  try {
    const inspectData = async (checkSignal = signal) => {
      const command = await prepareDatabaseInspectionCommand({
        project, node, environment, profile: target.databaseProfile, signal: checkSignal,
      });
      return readDatabaseInspectionResult(await run(command, checkSignal), target.databaseProfile);
    };
    const data = await inspectData();
    await configuration.checkFiles({ signal });
    await authority.check({ signal });
    const check = async ({ signal: checkSignal = signal } = {}) => {
      await authority.check({ signal: checkSignal });
      await configuration.checkFiles({ signal: checkSignal });
      await inspectData(checkSignal);
      await configuration.checkFiles({ signal: checkSignal });
      await authority.check({ signal: checkSignal });
    };
    return Object.freeze({
      compatibility: 'passed', commit: target.commit, mode: target.mode,
      adapter: target.mode === 'historical' ? 'agents-chat-638c553' : 'protocol-1',
      runtime, configuration, data, pendingChecks: Object.freeze([]), check,
    });
  } catch (error) {
    try { await configuration.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Windows compatibility admission and configuration cleanup failed.'); }
    throw error;
  }
}
