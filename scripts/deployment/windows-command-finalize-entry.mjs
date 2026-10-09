import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same, promisify } from 'node:util';
import { deploymentDiagnostics } from './deployment-diagnostics.mjs';
import { loadState } from './state.mjs';
import { verifyRecoveryEngine, retirementRecoveryInvocation } from './saved-recovery-engine.mjs';

const [control, project, operationId, manifestSha256, pwsh, phase] = process.argv.slice(2);
try {
  if (!['accepted', 'prior-runtime-restored'].includes(phase)) throw new Error('Unsupported command closeout phase.');
  const state = await loadState(control);
  if (state?.project !== project || state.operationId !== operationId || state.phase !== phase) {
    throw new Error('Original command closeout state changed.');
  }
  const engine = await verifyRecoveryEngine({ control, manifestSha256 });
  const command = retirementRecoveryInvocation(engine, { control, project, operationId, pwsh, kind: 'task' });
  const result = await promisify(execFile)(command.file, command.args, {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: command.env,
    timeout: 1800000, maxBuffer: 16384,
  });
  const completed = { status: 'completed', operationId, phase };
  if (result.stderr !== '' || !same(JSON.parse(result.stdout), completed)) {
    throw new Error('Saved finalizer did not return the exact original command completion.');
  }
  process.stdout.write(`${JSON.stringify(completed)}\n`);
} catch (error) {
  const code = 'DEPLOYMENT_WINDOWS_COMMAND_CLOSEOUT_FAILED';
  const message = 'Windows command closeout failed; retain original runtime and recovery evidence.';
  process.stdout.write(`${JSON.stringify({
    status: 'failed', code, message,
    diagnostics: deploymentDiagnostics(error, [new URL('./', import.meta.url).href]),
  })}\n`);
  process.stderr.write(`${message} (${code})\n`);
  process.exitCode = 1;
}
