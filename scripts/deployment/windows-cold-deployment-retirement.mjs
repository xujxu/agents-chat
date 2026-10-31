import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { acquireWindowsAdmission } from './windows-admission.mjs';
import { openWindowsColdRetirementAuthority } from './windows-cold-activation-recovery.mjs';
import { openWindowsColdRetirementScope } from './windows-cold-retirement-scope.mjs';
import { verifyHttpReadiness } from './http-readiness.mjs';

export async function retireWindowsColdRestoredDeployment({
  control, pwsh, acceptDataLoss, signal, onProgress,
} = {}) {
  signal?.throwIfAborted();
  if (acceptDataLoss !== true) throw new Error('Cold retirement requires explicit data-loss acknowledgement.');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('Invalid cold retirement progress callback.');
  if (process.platform !== 'win32' || ![control, pwsh].every(value => typeof value === 'string'
    && value.length <= 4096 && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw new Error('Cold retirement requires canonical native Windows control and PowerShell paths.');
  }
  let preparation;
  let admission;
  let scope;
  let result;
  const failures = [];
  try {
    let marker;
    try { marker = await lstat(path.join(control, 'worker-retirement.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!marker) {
      preparation = await openWindowsColdRetirementAuthority({ control, pwsh, acceptDataLoss, signal });
      const record = await preparation.prepareRetirement({ signal });
      await verifyHttpReadiness({ port: record.completion.port, providers: record.completion.providers, signal });
      await preparation.publishRetirement({ signal });
      await preparation.close();
      preparation = null;
    }
    admission = await acquireWindowsAdmission({ control, pwsh, signal });
    scope = await openWindowsColdRetirementScope({ control, pwsh, admission, signal });
    const notify = async step => {
      await onProgress?.(Object.freeze({
        step, operationId: scope.observation.operationId, runtime: scope.observation.runtime,
        retiredEntries: scope.observation.retiredEntries, totalEntries: scope.observation.totalEntries,
        identity: scope.identity, lease: 'released',
      }));
      signal?.throwIfAborted();
      if (step !== 'retired') await scope.check({ signal });
    };
    await notify('retirement-prepared');
    while (scope.observation.status !== 'retired') {
      await scope.advance({ signal });
      await notify(scope.observation.status === 'retired' ? 'retired' : 'entry-retired');
    }
    result = Object.freeze({ ...scope.observation, status: 'cold-restored-deployment-retired', lease: 'released' });
  } catch (error) { failures.push(error); }
  for (const resource of [scope, admission, preparation]) {
    if (!resource) continue;
    try { await resource.close(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) {
    throw Object.assign(new Error('Cold restored deployment retirement refused; retain original recovery evidence.', {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures, 'Cold retirement and cleanup failed.'),
    }), { code: 'DEPLOYMENT_WINDOWS_COLD_RETIREMENT_REFUSED', recoveryAllowed: false });
  }
  return result;
}
