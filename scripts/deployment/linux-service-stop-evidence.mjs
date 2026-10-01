import { isDeepStrictEqual as same } from 'node:util';
import { readEvidenceJournal } from './evidence-journal.mjs';
import { linuxInactiveObservationId } from './linux-inactive-service.mjs';
import { captureWorkerFields } from './worker-identity.mjs';

const profiles = Object.freeze({
  running: Object.freeze({ version: 1, phases: Object.freeze(['intent', 'inhibited', 'stop-requested', 'stopped']) }),
  stopped: Object.freeze({ version: 2, phases: Object.freeze(['intent', 'inhibited', 'stopped']) }),
});

export function linuxServiceStopProfile(priorRuntime) {
  if (!['running', 'stopped'].includes(priorRuntime)) throw new Error('Unsupported original service stop role.');
  return profiles[priorRuntime];
}

export async function readLinuxServiceStopEvidence({ root, project, lock, state }) {
  const { version, phases } = linuxServiceStopProfile(state.priorRuntime);
  const records = await readEvidenceJournal({
    root, project, name: 'service-stop.ndjson', maximumBytes: 256 * 1024, maximumRecords: 4,
    validate(value, records) {
      const fields = captureWorkerFields(value, ['version', 'lock', 'service', 'inhibition', 'phase'], 'cold stop receipt');
      const { phase, ...base } = fields;
      if (base.version !== version || !same(base.lock, lock) || phase !== phases[records.length]
        || base.service?.runtime?.project !== project
        || base.inhibition !== `/etc/systemd/system/${base.service?.runtime?.unit}.d/90-agents-chat-deployment.conf`
        || records.length && !same(base, {
          version, lock, service: records[0].service, inhibition: records[0].inhibition,
        })) throw new Error('Cold restore stop evidence does not bind the original lock and service.');
      return fields;
    },
  });
  if (records.length !== phases.length) throw new Error('Cold restore requires a complete original stop receipt.');
  const { runtime } = records[0].service;
  if (version === 1 && (!Number.isSafeInteger(runtime.mainPid) || runtime.mainPid <= 0
    || runtime.activeState !== 'active' || typeof runtime.processIdentity !== 'string' || !runtime.processIdentity)) {
    throw new Error('Cold stop receipt does not bind an originally running service.');
  }
  if (version === 2 && linuxInactiveObservationId(records[0].service) !== state.runtimeIdentity) {
    throw new Error('Cold stop receipt does not bind the original stopped observation identity.');
  }
  return records;
}
