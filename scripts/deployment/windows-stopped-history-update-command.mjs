import { createHash } from 'node:crypto';
import { readWorkerFile } from './worker-files.mjs';
import { withWindowsAdmission } from './windows-admission.mjs';
import { admitWindowsStoppedHistoryUpdate } from './windows-stopped-history-update-admission.mjs';
import { runWindowsInactiveDeployment } from './windows-inactive-deployment.mjs';
import { journalUncertain } from './evidence-journal.mjs';

const archivedHistory = /^retired-.+-inactive-rollback-history-(?:intent|complete)\.json$/;
// The archived rollback keeps its relocated runtime and runtime-evidence directories; neither is in-flight evidence.
const inFlight = /^(?:lock|recovery-lock|task-maintenance|task-retirement(?:-checkpoint)?\.json|live-retirement\.json|worker-retirement\.json|service-.*|inactive-rollback-(?!runtime$|runtime-evidence$).*|inactive-handoff-.*)$/;

// Archived stopped history is the only blocked control a public update may continue: its completed archive
// receipts remain, and nothing else holds task, lock, recovery or worker-retirement evidence.
export function isArchivedWindowsStoppedHistory(names, status) {
  if (process.platform !== 'win32' || status?.status !== 'blocked' || status.handoff) return false;
  const entries = names.map(name => String(name).toLowerCase());
  return entries.some(name => name.endsWith('-inactive-rollback-history-complete.json') && archivedHistory.test(name))
    && !entries.some(name => inFlight.test(name));
}

export async function runWindowsStoppedHistoryUpdate({
  options, project, control, taskName, node, npmCli, git, pwsh, admission, signal, onProgress,
}) {
  if (options.operation !== 'update' || options.firstInstall) {
    throw new Error('Only a public update may continue archived stopped history.');
  }
  const routed = await withWindowsAdmission(control, { pwsh, admission }, retained =>
    admitWindowsStoppedHistoryUpdate({ project, control, taskName, pwsh, admission: retained, signal }));
  let configuration;
  try {
    const bytes = await readWorkerFile(routed.scope.observation.configuration, 4 * 1024 * 1024, { privateMode: true });
    if (createHash('sha256').update(bytes).digest('hex') !== routed.scope.observation.configurationSha256) {
      throw Object.assign(new Error('Installed runtime configuration changed during command admission.'), {
        code: 'DEPLOYMENT_CONFIGURATION_CHANGED',
      });
    }
    configuration = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    const errors = [error];
    try { await routed.scope.close(); }
    catch (cleanup) { errors.push(journalUncertain(cleanup)); }
    const failure = errors.length === 1 ? error
      : journalUncertain(new AggregateError(errors, 'Inactive update configuration and handoff scope cleanup failed.'));
    throw Object.assign(failure, { handoffRetained: true, operationId: routed.lock.operationId });
  }
  return runWindowsInactiveDeployment({
    ...options, routed, control, node, npmCli, git, pwsh,
    environment: configuration.command.environment, port: 3010, deploymentBytes: 2 * 1024 ** 3,
    signal, onProgress,
  });
}
