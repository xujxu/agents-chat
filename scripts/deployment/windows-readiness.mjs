import { validateReadinessProviders, verifyHttpReadiness, waitReadiness } from './http-readiness.mjs';

export async function verifyWindowsReadiness({ context, port, providers, signal }) {
  signal?.throwIfAborted();
  validateReadinessProviders(providers);
  const listener = await context.listener({ port, signal });
  if (listener.status === 'not-ready') {
    throw Object.assign(new Error('Readiness listener is not yet available.'), {
      code: 'DEPLOYMENT_READINESS_NOT_READY',
    });
  }
  if (listener.status !== 'retained' || listener.port !== port) {
    throw new Error('Original Windows readiness listener differs.');
  }
  await verifyHttpReadiness({ port, providers, signal });
  await context.check({ signal });
  return Object.freeze({
    status: 'ready', generation: listener.generation, port,
    providers: Object.freeze([...providers]),
  });
}

export async function waitWindowsReadiness({ context, port, providers, waitSeconds = 120, signal }) {
  return waitReadiness(stageSignal => verifyWindowsReadiness({ context, port, providers, signal: stageSignal }),
    { waitSeconds, signal });
}
