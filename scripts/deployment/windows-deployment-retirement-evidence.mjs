import { isDeepStrictEqual } from 'node:util';
import { readWorkerOperation } from './worker-operation.mjs';
import { readWorkerJournal } from './worker-journal.mjs';
import { verifyWorkerEngine } from './saved-worker-engine.mjs';
import { captureWindowsDeploymentRetirementRecord } from './windows-deployment-retirement-record.mjs';

// The native task scope retains every file before this read and through manifest publication.
export async function verifyWindowsDeploymentRetirementEvidence(control, supplied) {
  const record = captureWindowsDeploymentRetirementRecord(supplied);
  if (record.control !== control) throw new Error('Original retirement control differs.');
  await verifyWindowsCompletedWorkerEvidence(control, {
    lock: record.task.intent.intent.lock, workerManifestSha256: record.workerManifestSha256,
    entries: record.entries.slice(1),
  });
  return record;
}

export async function verifyWindowsCompletedWorkerEvidence(control, { lock, workerManifestSha256, entries }) {
  const operation = await readWorkerOperation(control);
  if (operation.at(-1).phase !== 'sealed' || !isDeepStrictEqual(operation[0].lock, lock)
    || operation[0].manifestSha256 !== workerManifestSha256) {
    throw new Error('Original worker operation is not sealed for this completed task.');
  }
  await verifyWorkerEngine({ control, project: lock.project, operationId: lock.operationId,
    manifestSha256: workerManifestSha256 });
  const workerIds = operation.filter(entry => entry.phase === 'enrolled').map(entry => entry.workerId);
  const expected = workerIds.map(workerId => `worker-${workerId}.ndjson`);
  const actual = entries.slice(0, workerIds.length).map(entry => entry.path);
  const allJournals = entries.filter(entry => /^worker-[a-f0-9-]+\.ndjson$/.test(entry.path));
  if (!isDeepStrictEqual(actual, expected) || allJournals.length !== workerIds.length) {
    throw new Error('Original worker enrollment differs from retained cleanup inventory.');
  }
  for (const workerId of workerIds) {
    const receipts = await readWorkerJournal(control, {
      project: lock.project, operationId: lock.operationId, workerId, controllerIdentity: lock.processIdentity,
    });
    if (receipts.at(-1).phase !== 'settled'
      || receipts.some(entry => entry.domain && entry.domain.kind !== 'windows-job')) {
      throw new Error('Original Windows worker has not settled.');
    }
  }
}
