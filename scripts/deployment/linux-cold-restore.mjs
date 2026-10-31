import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { externalWorkerDirectory } from './worker-files.mjs';
import { restoreLinuxColdFiles } from './linux-cold-restore-files.mjs';
import { activateLinuxColdRestore } from './linux-cold-restore-activation.mjs';
import { completeLinuxColdRestore } from './linux-cold-restore-completion.mjs';
import { coldCompletionMarker, coldRetirementMarker } from './linux-cold-retirement-proof.mjs';

export async function runLinuxColdRestore(options) {
  if (options.acceptDataLoss !== true) throw new Error('Cold restore requires explicit data-loss acknowledgement.');
  const { root } = await externalWorkerDirectory(options.control, options.project);
  const expectedNative = { unit: options.unit, npm: options.npm, node: options.node };
  const names = await readdir(root);
  const recovery = { ...options, control: root, expectedNative };
  if (names.includes(coldRetirementMarker) || names.includes(coldCompletionMarker)) {
    return completeLinuxColdRestore(recovery);
  }
  if (names.includes('recovery-lock')) {
    const guard = await readdir(path.join(root, 'recovery-lock'));
    if (guard.includes('activation-intent.json') || guard.includes('activation-ready.json')) {
      return completeLinuxColdRestore(recovery);
    }
  }
  let restored;
  let active;
  let result;
  const errors = [];
  try {
    restored = await restoreLinuxColdFiles(recovery);
    active = await activateLinuxColdRestore({ ...recovery, restored });
    result = await completeLinuxColdRestore({ ...recovery, restored, active });
  } catch (error) { errors.push(error); }
  const closed = await Promise.allSettled([active?.close(), restored?.close()]);
  errors.push(...closed.filter(value => value.status === 'rejected').map(value => value.reason));
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Cold restoration and authority cleanup failed.');
  return result;
}
