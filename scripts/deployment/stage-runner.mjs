import { performance } from 'node:perf_hooks';

function deadline(milliseconds, callback) {
  const started = performance.now();
  let timer;
  const tick = () => {
    const remaining = milliseconds - (performance.now() - started);
    if (remaining <= 0) callback();
    else timer = setTimeout(tick, Math.min(Math.ceil(remaining), 2147483647));
  };
  tick();
  return () => clearTimeout(timer);
}

function stageError(stage, code, started, recoveryAllowed, cause) {
  const message = code === 'DEPLOYMENT_WORKER_UNSETTLED'
    ? `Deployment stage ${stage} has not confirmed worker termination; retain the lock and backup. Do not restore or restart until owned workers are stopped.`
    : `Deployment stage ${stage} ${code === 'DEPLOYMENT_STAGE_TIMEOUT' ? 'timed out' : 'was cancelled'}.`;
  return Object.assign(new Error(message, { cause }), {
    code, stage, recoveryAllowed, elapsedMs: Math.max(0, performance.now() - started),
  });
}

// Workers must settle only after all owned descendants and writers have stopped.
// If termination cannot be confirmed, they must reject with recoveryAllowed=false.
export async function runStage(stage, worker, {
  timeoutMs = 1800000, settlementMs = 30000, signal,
} = {}) {
  if (typeof stage !== 'string' || !/^[a-z][a-zA-Z-]{0,63}$/.test(stage)
    || typeof worker !== 'function'
    || ![timeoutMs, settlementMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid deployment stage or time budget.');
  }
  const started = performance.now();
  if (signal?.aborted) throw stageError(stage, 'DEPLOYMENT_STAGE_CANCELLED', started, true);
  const controller = new AbortController();
  let interrupted;
  let notify;
  const interruption = new Promise(resolve => { notify = resolve; });
  const interrupt = code => {
    if (interrupted) return;
    interrupted = stageError(stage, code, started, true);
    controller.abort(interrupted);
    notify({ interrupted: true });
  };
  const cancel = () => interrupt('DEPLOYMENT_STAGE_CANCELLED');
  signal?.addEventListener('abort', cancel, { once: true });
  const clearDeadline = deadline(timeoutMs, () => interrupt('DEPLOYMENT_STAGE_TIMEOUT'));
  let clearSettlement;
  try {
    const completed = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return worker(controller.signal);
    }).then(
      value => ({ value }), error => ({ error }),
    );
    const first = await Promise.race([completed, interruption]);
    if (!interrupted) {
      if (Object.hasOwn(first, 'error')) throw first.error;
      return first.value;
    }
    const settled = await Promise.race([
      completed,
      new Promise(resolve => {
        clearSettlement = deadline(settlementMs, () => resolve({ unsettled: true }));
      }),
    ]);
    if (settled.unsettled || settled.error?.recoveryAllowed === false) {
      throw stageError(stage, 'DEPLOYMENT_WORKER_UNSETTLED', started, false,
        settled.error ?? interrupted);
    }
    throw stageError(stage, interrupted.code, started, true, settled.error);
  } finally {
    clearDeadline();
    clearSettlement?.();
    signal?.removeEventListener('abort', cancel);
  }
}
