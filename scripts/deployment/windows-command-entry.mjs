import { deploymentDiagnostics } from './deployment-diagnostics.mjs';
import { journalUncertain } from './evidence-journal.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';
import { runWindowsDeploymentCommand } from './windows-deployment-command.mjs';

const [operation, project, control, taskName, pwsh, git, npmCli, ...args] = process.argv.slice(2);
try {
  const result = await runWindowsDeploymentCommand({
    operation, args, project, control, taskName, pwsh, git, npmCli, node: process.execPath,
    onProgress: ({ phase }) => process.stderr.write(`${new Date().toISOString()} Windows deployment phase: ${phase}\n`),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  let failure = error;
  const closeout = error.closeoutRequired === true && !hasUnsettledWorker(error)
    && typeof error.operationId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(error.operationId)
    && typeof error.recoveryEngine === 'string' && /^[a-f0-9]{64}$/.test(error.recoveryEngine);
  if (error.closeoutRequired === true && !closeout) {
    failure = journalUncertain(new Error('Completed command closeout binding is invalid.', { cause: error }));
  }
  const code = typeof failure.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(failure.code)
    ? failure.code : 'DEPLOYMENT_WINDOWS_COMMAND_FAILED';
  const message = 'Windows deployment command failed; retain backup, lock and recovery evidence.';
  const diagnostics = deploymentDiagnostics(failure, [new URL('./', import.meta.url).href]);
  process.stdout.write(`${JSON.stringify({
    status: 'failed', code, message, diagnostics, closeoutRequired: closeout,
    operationId: closeout ? error.operationId : null,
    recoveryEngine: closeout ? error.recoveryEngine : null,
  })}\n`);
  process.stderr.write(`${message} (${code})\n`);
  process.exitCode = 1;
}
