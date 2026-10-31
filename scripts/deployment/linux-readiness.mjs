import { retainLinuxListener } from './linux-listener.mjs';
import { validateReadinessProviders, verifyHttpReadiness, waitReadiness } from './http-readiness.mjs';

export async function verifyLinuxReadiness({ service, port, providers, signal }) {
  signal?.throwIfAborted();
  validateReadinessProviders(providers);
  const owned = await retainLinuxListener({ service, port, signal });
  await verifyHttpReadiness({ port, providers, signal });
  await owned.check();
  return Object.freeze({
    status: 'ready', invocationId: service.identity.runtime.invocationId, port,
    providers: Object.freeze([...providers]),
  });
}

export async function waitLinuxReadiness({ service, port, providers, waitSeconds = 120, signal }) {
  return waitReadiness(stageSignal => verifyLinuxReadiness({ service, port, providers, signal: stageSignal }),
    { waitSeconds, signal });
}
