import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArguments } from './cli.mjs';
import { prepareWindowsRestoreInvocation } from './windows-restore-invocation.mjs';
import { journalUncertain } from './evidence-journal.mjs';

export async function runWindowsRestoreCommand({ args, project, control, taskName, pwsh, node }) {
  const options = parseArguments('restore', args);
  if (options.help) return { status: 'help', message: 'Saved Windows restoration requires --accept-data-loss; an already released cold runtime can finish its completion journal, publish terminal state, recover its receipt and finish retirement, but pre-release or inactive cold recovery is not yet supported.' };
  if (!options.acceptDataLoss) {
    throw Object.assign(new Error('Explicit data-loss acknowledgement is required.'), {
      code: 'DEPLOYMENT_DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED',
    });
  }
  if (node !== process.execPath || typeof project !== 'string'
    || options.project !== undefined && options.project !== project
    || control !== path.join(path.dirname(project), `.${path.basename(project)}.deployment`)) {
    throw new Error('Restore command context differs from its installed project.');
  }
  const invocation = await prepareWindowsRestoreInvocation({ project, taskName, pwsh, timeoutSeconds: options.timeoutSeconds });
  const environment = {};
  for (const key of ['SystemRoot', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  const pending = promisify(execFile)(invocation.file, invocation.args, {
    cwd: path.dirname(invocation.args[0]), env: environment, maxBuffer: 32768,
    timeout: Math.min(options.timeoutSeconds * 16000 + 120000, 2147483647),
  });
  let inputError;
  pending.child.stdin.on('error', error => { inputError = error; });
  pending.child.stderr.on('data', bytes => process.stderr.write(bytes));
  pending.child.stdin.end(JSON.stringify(invocation.input));
  let output;
  let failed = false;
  try { output = await pending; }
  catch (error) {
    if (error.killed || error.signal || error.code !== 1) {
      throw journalUncertain(new Error('Saved restore process did not settle with a supported outcome.', { cause: error }));
    }
    output = error;
    failed = true;
  }
  if (inputError && (inputError.code !== 'EPIPE' || !failed)) throw inputError;
  const result = JSON.parse(output.stdout);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.closeoutRequired !== 'boolean') throw new Error('Invalid saved restore outcome.');
  const bound = typeof result.operationId === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.operationId)
    && result.recoveryEngine === invocation.args[2];
  if (result.closeoutRequired && !bound) throw new Error('Saved restore closeout binding differs from its invocation.');
  if (failed) {
    if (result.status !== 'failed' || typeof result.code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(result.code)) {
      throw new Error('Saved restore failure protocol is invalid.');
    }
    throw Object.assign(new Error('Saved Windows restoration failed; retain its original evidence.'), {
      code: result.code, closeoutRequired: result.closeoutRequired,
      operationId: result.closeoutRequired ? result.operationId : null,
      recoveryEngine: result.closeoutRequired ? result.recoveryEngine : null,
    });
  }
  if (result.status !== 'restored' || result.backupId !== invocation.backupId
    || result.closeoutRequired !== true || result.runtimeRelocated !== true || !bound) {
    throw new Error('Saved restore did not return matching restored acceptance.');
  }
  return result;
}
