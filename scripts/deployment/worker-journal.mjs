import { captureWorkerFields, captureOwner, captureDomain } from './worker-identity.mjs';
import { createEvidenceJournal, readEvidenceJournal, journalUncertain } from './evidence-journal.mjs';

const transitions = {
  intent: ['owned', 'settled', 'blocked'],
  owned: ['admitted', 'settled', 'blocked'],
  admitted: ['settled', 'blocked'],
  settled: ['blocked'],
  blocked: [],
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function options(root, suppliedOwner) {
  const owner = captureOwner(suppliedOwner);
  return {
    root, project: owner.project, name: `worker-${owner.workerId}.ndjson`,
    maximumBytes: 128 * 1024, maximumRecords: 5,
    validate(value, records) {
      const previous = records.at(-1);
      const fields = captureWorkerFields(value, ['version', 'owner', 'phase', 'domain'], 'receipt');
      const recordedOwner = captureOwner(fields.owner);
      const domain = fields.domain === null ? null : captureDomain(fields.domain, recordedOwner);
      if (fields.version !== 1 || !same(recordedOwner, owner)
        || !Object.hasOwn(transitions, fields.phase)
        || (['owned', 'admitted'].includes(fields.phase) && domain === null)
        || (previous
          ? !transitions[previous.phase].includes(fields.phase)
            || (previous.domain !== null && !same(previous.domain, domain))
          : fields.phase !== 'intent' || domain !== null)) {
        throw new Error('Invalid worker receipt identity or transition.');
      }
      return Object.freeze({ version: 1, owner: recordedOwner, phase: fields.phase, domain });
    },
  };
}

export async function createWorkerJournal(root, owner) {
  let configuration;
  try { configuration = options(root, owner); }
  catch (error) { throw journalUncertain(error); }
  return createEvidenceJournal(configuration);
}

export async function readWorkerJournal(root, owner) {
  let configuration;
  try { configuration = options(root, owner); }
  catch (error) { throw journalUncertain(error); }
  return readEvidenceJournal(configuration);
}
