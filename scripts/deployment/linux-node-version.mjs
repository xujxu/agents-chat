import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { hasUnsettledWorker } from './worker-errors.mjs';

function refusal(check) {
  return Object.assign(new Error(`Runtime compatibility refused: ${check}.`), {
    code: 'DEPLOYMENT_RUNTIME_UNSUPPORTED', check,
    nextAction: 'Inspect the installed Node executable and original service account before updating.',
  });
}

export async function inspectLinuxNodeVersion({ service, operation, signal }) {
  try {
    signal?.throwIfAborted();
    await service.check();
    const { project, home, user, uid, gid } = service.identity.runtime;
    const node = service.identity.executables[1].file;
    const result = await operation.run({
      workerId: randomUUID(), signal, runtime: { uid, gid },
      command: { file: node, args: ['--version'], cwd: project, env: {
        HOME: home, USER: user, LOGNAME: user, LANG: 'C', LC_ALL: 'C',
        PATH: `${path.dirname(node)}:/usr/bin:/bin`,
      } },
    });
    signal?.throwIfAborted();
    await service.check();
    if (typeof result.stdout !== 'string' || result.stdout.length > 64 || result.stderr !== '') {
      throw refusal('node-version-output');
    }
    const match = result.stdout.match(/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\r?\n?$/);
    if (!match || match[0] !== result.stdout) throw refusal('node-version-output');
    return Object.freeze({ status: 'runtime-observed', platform: 'linux', nodeVersion: match[1] });
  } catch (error) {
    if (hasUnsettledWorker(error)) {
      throw Object.assign(new Error('Runtime observation worker could not be proven settled.'), {
        code: 'DEPLOYMENT_WORKER_UNSETTLED', recoveryAllowed: false,
        nextAction: 'Retain the lock and worker recovery evidence; do not stop, restart or restore the application.',
      });
    }
    signal?.throwIfAborted();
    if (error?.code === 'DEPLOYMENT_RUNTIME_UNSUPPORTED') throw error;
    throw refusal('node-version-observation');
  }
}
