import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// Both intents describe the same retained files, but worker paths are relative.
export function validateWorkerRetirementHandoff(bytes, control, service) {
  if (![3, 4].includes(service.version) || !service.workers) {
    throw new Error('Worker retirement requires the original combined service inventory.');
  }
  const relative = ({ file, ...entry }) => ({ path: path.relative(control, file), ...entry });
  const expected = {
    version: 2,
    lock: service.lock,
    manifestSha256: service.workers.manifestSha256,
    state: relative(service.stateFile),
    files: service.workers.files.map(relative),
    lockFile: relative(service.lockFile),
    controlIdentity: service.controlIdentity,
    lockIdentity: service.lockIdentity,
    engineIdentity: service.workers.engineIdentity,
  };
  const actual = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error('Worker retirement does not match the original live service handoff.');
  }
}
