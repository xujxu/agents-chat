import { createHash } from 'node:crypto';
import path from 'node:path';
import { withWindowsAdmission } from './windows-admission.mjs';
import { openWindowsColdRetirementAuthority, prepareWindowsColdCompletionRecovery,
  publishWindowsColdTerminalState } from './windows-cold-activation-recovery.mjs';
import { openWindowsColdRetirementScope } from './windows-cold-retirement-scope.mjs';
import { recoverWindowsColdRestoredDeploymentReceipt } from './windows-cold-receipt-recovery.mjs';
import { verifyHttpReadiness } from './http-readiness.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { validateState } from './state.mjs';

function assertScope({
  control, project, taskName, snapshot, pwsh, acceptDataLoss, signal,
}) {
  signal?.throwIfAborted();
  if (acceptDataLoss !== true) throw new Error('Cold retirement closeout requires explicit data-loss acknowledgement.');
  if (process.platform !== 'win32' || ![control, project, pwsh].every(value => typeof value === 'string'
    && value.length <= 4096 && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value))
    || control !== path.join(path.dirname(project), `.${path.basename(project)}.deployment`)
    || typeof taskName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(taskName)
    || snapshot?.version !== 3 || snapshot.scope !== 'project' || snapshot.project !== project
    || snapshot.runtime?.platform !== 'win32' || snapshot.runtime.task?.name !== taskName
    || typeof snapshot.id !== 'string' || !/^[a-zA-Z0-9_.:-]+$/.test(snapshot.id)
    || typeof snapshot.source?.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.source.commit)
    || typeof snapshot.recoveryEngine !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.recoveryEngine)) {
    throw new Error('Cold retirement closeout requires the verified saved Windows snapshot scope.');
  }
}

async function readBoundState(record, { control, project, taskName, snapshot }) {
  const bytes = await readWorkerFile(path.join(control, 'state.json'), 65536, { privateMode: true });
  const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (record.project !== project || record.lock.operationId !== state.operationId
    || record.completion.taskName !== taskName || record.completion.port !== 3010
    || createHash('sha256').update(bytes).digest('hex') !== record.state.sha256
    || state.project !== project || state.operation !== 'restore' || state.phase !== 'restored'
    || state.previousPhase !== 'restore-activating' || state.errorCode !== null
    || state.backupId !== snapshot.id || state.targetCommit !== snapshot.source.commit) {
    throw new Error('Original cold retirement differs from the verified saved restore snapshot.');
  }
  return state;
}

export async function prepareWindowsColdCompletionCloseout(options = {}) {
  assertScope(options);
  const { control, pwsh, snapshot, signal } = options;
  const recovery = await prepareWindowsColdCompletionRecovery({
    control, pwsh, acceptDataLoss: true, expectedSnapshot: snapshot, signal,
  });
  let failure;
  try {
    let progress = recovery.observation;
    while (progress.step !== 'complete') progress = await recovery.advance({ signal });
    await recovery.prepareTerminal({ signal });
  } catch (error) { failure = error; throw error; }
  finally {
    try { await recovery.close(); }
    catch (error) {
      throw new AggregateError(failure ? [failure, error] : [error], 'Cold completion closeout cleanup failed.');
    }
  }
  return prepareWindowsColdStateCloseout(options);
}

export async function prepareWindowsColdStateCloseout(options = {}) {
  assertScope(options);
  const { control, pwsh, snapshot, signal } = options;
  await publishWindowsColdTerminalState({
    control, pwsh, acceptDataLoss: true, expectedSnapshot: snapshot, signal,
  });
  return prepareWindowsColdReceiptCloseout(options);
}

export async function prepareWindowsColdReceiptCloseout(options = {}) {
  assertScope(options);
  const { control, pwsh, snapshot, signal } = options;
  await recoverWindowsColdRestoredDeploymentReceipt({
    control, pwsh, acceptDataLoss: true, expectedSnapshot: snapshot, signal,
  });
  return prepareWindowsColdTerminalCloseout(options);
}

export async function prepareWindowsColdTerminalCloseout(options = {}) {
  assertScope(options);
  const { control, pwsh, signal } = options;
  let authority;
  const failures = [];
  try {
    authority = await openWindowsColdRetirementAuthority({ control, pwsh, signal, acceptDataLoss: true });
    const record = await authority.prepareRetirement({ signal });
    await readBoundState(record, options);
    await verifyHttpReadiness({ port: record.completion.port, providers: record.completion.providers, signal });
    await authority.publishRetirement({ signal });
  } catch (error) { failures.push(error); }
  try { await authority?.close(); }
  catch (error) { failures.push(error); }
  if (failures.length) {
    throw Object.assign(new Error('Saved cold terminal closeout refused; retain original recovery evidence.', {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures, 'Cold terminal preparation and cleanup failed.'),
    }), { code: 'DEPLOYMENT_WINDOWS_COLD_CLOSEOUT_REFUSED', recoveryAllowed: false });
  }
  return prepareWindowsColdRetirementCloseout(options);
}

export async function prepareWindowsColdRetirementCloseout(options = {}) {
  assertScope(options);
  const { control, project, taskName, snapshot, pwsh, signal } = options;
  try {
    return await withWindowsAdmission(control, { pwsh }, async admission => {
      let scope;
      let failure;
      try {
        scope = await openWindowsColdRetirementScope({ control, pwsh, admission, signal });
        const state = await readBoundState(scope.record, { control, project, taskName, snapshot });
        await scope.check({ signal });
        return Object.freeze({
          status: 'restored', operationId: state.operationId, backupId: snapshot.id,
          recoveryEngine: snapshot.recoveryEngine, closeoutRequired: true, runtimeRelocated: true,
        });
      } catch (error) { failure = error; throw error; }
      finally {
        try { await scope?.close(); }
        catch (error) {
          throw new AggregateError(failure ? [failure, error] : [error], 'Saved cold retirement admission cleanup failed.');
        }
      }
    });
  } catch (cause) {
    throw Object.assign(new Error('Saved cold retirement closeout refused; retain original recovery evidence.', { cause }), {
      code: 'DEPLOYMENT_WINDOWS_COLD_CLOSEOUT_REFUSED', recoveryAllowed: false,
    });
  }
}
