import { prepareWindowsColdPolicyRecovery } from './windows-cold-activation-recovery.mjs';
import { assertWindowsSavedColdScope } from './windows-cold-retirement-closeout.mjs';

export async function recoverWindowsColdStartupPolicy(options = {}) {
  assertWindowsSavedColdScope(options);
  const recovery = await prepareWindowsColdPolicyRecovery({
    control: options.control, pwsh: options.pwsh, signal: options.signal,
    acceptDataLoss: true, expectedSnapshot: options.snapshot,
  });
  let failure;
  try {
    let progress = recovery.observation;
    while (!progress.claimed || progress.step !== 'restored') {
      progress = await recovery.advance({ signal: options.signal });
    }
    return await recovery.archive({ signal: options.signal });
  } catch (error) { failure = error; throw error; }
  finally {
    try { await recovery.close(); }
    catch (error) {
      throw new AggregateError(failure ? [failure, error] : [error], 'Cold startup policy recovery cleanup failed.');
    }
  }
}
