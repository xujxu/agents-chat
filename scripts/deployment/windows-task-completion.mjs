import { waitWindowsReadiness } from './windows-readiness.mjs';
import { validateReadinessProviders } from './http-readiness.mjs';

export async function completeWindowsTaskActivation({
  context, port, providers, recordAcceptance, waitSeconds = 120, signal,
}) {
  signal?.throwIfAborted();
  if (typeof recordAcceptance !== 'function') throw new Error('Completion requires explicit acceptance-state publication.');
  validateReadinessProviders(providers);
  const admittedProviders = Object.freeze([...providers]);
  await waitWindowsReadiness({ context, port, providers: admittedProviders, waitSeconds, signal });
  await context.prepareCompletion({ port, providers: admittedProviders, signal });
  try {
    signal?.throwIfAborted();
    const stateSha256 = await recordAcceptance();
    await context.complete({ stateSha256, signal });
    return Object.freeze({ status: 'completed', stateSha256 });
  } catch (error) {
    try { await context.close(); }
    catch (cleanup) {
      if (cleanup !== error) throw new AggregateError([error, cleanup], 'Task completion and authority cleanup failed.');
    }
    throw error;
  }
}
