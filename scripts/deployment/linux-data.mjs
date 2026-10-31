import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  databaseInspectionRefusal, prepareDatabaseInspectionCommand, readDatabaseInspectionResult,
} from './database-command.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';

export async function inspectLinuxData({ service, operation, profile, signal }) {
  try {
    signal?.throwIfAborted();
    await service.check();
    const { project, home, user, uid, gid } = service.identity.runtime;
    const node = service.identity.executables[1].file;
    const command = await prepareDatabaseInspectionCommand({
      project, node, profile, signal, environment: {
        HOME: home, USER: user, LOGNAME: user, LANG: 'C', LC_ALL: 'C',
        PATH: `${path.dirname(node)}:/usr/bin:/bin`,
      },
    });
    const output = await operation.run({ workerId: randomUUID(), command, runtime: { uid, gid }, signal });
    signal?.throwIfAborted();
    await service.check();
    return readDatabaseInspectionResult(output, profile);
  } catch (error) {
    if (hasUnsettledWorker(error)) {
      throw Object.assign(new Error('Database observation worker could not be proven settled.'), {
        code: 'DEPLOYMENT_WORKER_UNSETTLED', recoveryAllowed: false,
        nextAction: 'Retain the lock and worker recovery evidence; do not stop, restart or restore the application.',
      });
    }
    signal?.throwIfAborted();
    if (error?.code === 'DEPLOYMENT_DATABASE_UNSUPPORTED') throw error;
    throw databaseInspectionRefusal('worker-inspection');
  }
}
