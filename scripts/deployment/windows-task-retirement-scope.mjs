import { captureWorkerFields } from './worker-identity.mjs';
import { captureWindowsTaskRetirementCheckpoint } from './windows-task-retirement-checkpoint.mjs';

export function captureWindowsTaskRetirementScope(value) {
  const result = captureWorkerFields(value, ['status', 'retiredFiles', 'checkpoint'], 'retirement scope');
  const checkpoint = captureWindowsTaskRetirementCheckpoint(result.checkpoint);
  if (result.status !== 'retiring' || !Number.isSafeInteger(result.retiredFiles)
    || result.retiredFiles < 0 || result.retiredFiles > checkpoint.intent.intent.files.length) {
    throw new Error('Invalid native receipt retirement scope.');
  }
  return Object.freeze({ ...result, checkpoint });
}
