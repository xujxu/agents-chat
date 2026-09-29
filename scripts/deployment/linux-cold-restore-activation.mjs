import { inspectLinuxStoppedConfiguration, inspectLinuxConfiguration } from './linux-configuration.mjs';
import { activateLinuxService } from './linux-service-activation.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { waitLinuxReadiness } from './linux-readiness.mjs';
import { runStage } from './stage-runner.mjs';
import { journalUncertain } from './evidence-journal.mjs';

export async function activateLinuxColdRestore({ restored, port, waitSeconds = 120, timeoutSeconds = 1800, signal }) {
  if (restored?.status !== 'files-restored' || !Number.isInteger(port) || port < 1 || port > 65535
    || ![waitSeconds, timeoutSeconds].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Cold activation requires restored files, an explicit port and positive deadlines.');
  }
  const { service, snapshot } = restored;
  const { unit, project } = service.identity.runtime;
  const native = { unit, project, npm: service.identity.executables[0].file, node: service.identity.executables[1].file };
  let activation;
  let active;
  let authority;
  let configuration;
  let closed = false;
  const observationSignal = new AbortController().signal;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([active?.close(), activation?.close()]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw journalUncertain(new AggregateError(errors, 'Cold activation handle cleanup failed.'));
  };
  const stage = (name, work, seconds = timeoutSeconds) => runStage(name, work, {
    signal, timeoutMs: Math.min(seconds * 1000, Number.MAX_SAFE_INTEGER),
  });
  try {
    configuration = await stage('cold-activation-configuration', async stageSignal => {
      await restored.check({ signal: stageSignal });
      return inspectLinuxStoppedConfiguration({ service, snapshot, profile: 'agents-chat-auth-638c553', signal: stageSignal });
    });
    authority = await stage('cold-activation-intent', stageSignal => restored.prepareActivation({ signal: stageSignal }));
    await stage('cold-activation-start', async stageSignal => {
      const checkAuthority = async () => {
        const state = await authority.check({ signal: observationSignal });
        await configuration.check({ signal: observationSignal });
        return state;
      };
      stageSignal.throwIfAborted();
      activation = await activateLinuxService({
        ...native, control: authority.control, lock: authority.lock, service,
        inhibition: `/etc/systemd/system/${unit}.d/90-agents-chat-deployment.conf`,
        checkAuthority,
        checkInhibition: () => service.check(),
      }, 'restore');
      active = await inspectLinuxService(native);
    });
    await stage('cold-activation-readiness', async stageSignal => {
      await authority.check({ signal: stageSignal });
      await configuration.check({ signal: stageSignal });
      const current = await inspectLinuxConfiguration({ service: active, profile: configuration.profile, signal: stageSignal });
      await waitLinuxReadiness({ service: active, port, providers: current.providers, waitSeconds, signal: stageSignal });
      await current.check({ signal: stageSignal });
    }, Math.min(waitSeconds, timeoutSeconds));
    return Object.freeze({
      status: 'ready-to-commit', identity: active.identity, close,
      async check() {
        if (closed) throw new Error('Cold activation authority is closed.');
        await authority.check({ signal: observationSignal });
        await configuration.check({ signal: observationSignal });
        await active.check();
      },
    });
  } catch (error) {
    const errors = [error];
    if (activation) {
      try { await activation.stop(); }
      catch (cleanup) { errors.push(cleanup); }
    }
    try { await close(); }
    catch (cleanup) { errors.push(cleanup); }
    if (errors.length > 1) throw journalUncertain(new AggregateError(errors, 'Cold activation and owned cleanup failed.'));
    throw error;
  }
}
