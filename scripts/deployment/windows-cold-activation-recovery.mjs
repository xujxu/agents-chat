import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { acquireWindowsAdmission, assertWindowsAdmission } from './windows-admission.mjs';
import { inspectWindowsColdRestoreEvidence, windowsColdDirectoryIdentity } from './windows-cold-restore-lease.mjs';
import { captureLockOwner } from './state.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureActivatedRuntime } from './windows-task-controller.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';
import { captureWindowsColdPolicyHistory } from './windows-cold-policy-history.mjs';
import { captureWindowsColdArchiveFiles, verifyWindowsColdArchiveFiles } from './windows-cold-policy-archive.mjs';
import { captureWindowsColdRuntimeCompletion, captureWindowsColdCompletionPrefix,
  windowsColdCompletionPhases } from './windows-cold-runtime-completion.mjs';
import { captureWindowsColdTerminalFiles, captureWindowsColdTerminalIntent } from './windows-cold-terminal-intent.mjs';

const script = fileURLToPath(new URL('./windows-stopped-restore-controller.ps1', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const refused = cause => Object.assign(new Error('Cold activation observation refused; retain original recovery evidence.', { cause }), {
  code: 'DEPLOYMENT_WINDOWS_COLD_ACTIVATION_OBSERVATION_REFUSED', recoveryAllowed: false,
});

export async function inspectWindowsColdActivationRecovery({ control, pwsh, signal } = {}) {
  return openRecovery({ control, pwsh, signal }, false);
}

export async function inspectWindowsColdRuntimeCompletion({ control, pwsh, signal } = {}) {
  return openRecovery({ control, pwsh, signal }, false, true);
}

export async function prepareWindowsColdCompletionRecovery({ control, pwsh, signal, acceptDataLoss } = {}) {
  signal?.throwIfAborted();
  if (acceptDataLoss !== true) throw new Error('Cold completion recovery requires explicit data-loss acknowledgement.');
  return openRecovery({ control, pwsh, signal }, false, true, true);
}

export async function prepareWindowsColdTerminalRestore(options = {}) {
  const recovery = await prepareWindowsColdCompletionRecovery(options);
  let failure;
  try { return await recovery.prepareTerminal({ signal: options.signal }); }
  catch (error) { failure = error; throw error; }
  finally {
    try { await recovery.close(); }
    catch (error) {
      throw new AggregateError(failure ? [failure, error] : [error], 'Cold terminal handoff cleanup failed.');
    }
  }
}

export async function prepareWindowsColdPolicyRecovery({ control, pwsh, signal, acceptDataLoss } = {}) {
  signal?.throwIfAborted();
  if (acceptDataLoss !== true) throw new Error('Cold policy recovery requires explicit data-loss acknowledgement.');
  return openRecovery({ control, pwsh, signal }, true);
}

async function openRecovery({ control, pwsh, signal }, policyRecovery, completedRuntime = false, completionRecovery = false) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || ![control, pwsh].every(value => typeof value === 'string'
    && value.length <= 4096 && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value))) {
    throw refused(new Error('Canonical native Windows control and PowerShell paths are required.'));
  }
  const admission = await acquireWindowsAdmission({ control, pwsh, signal });
  let bridge;
  try {
    const stateBytes = await readWorkerFile(path.join(control, 'state.json'), 65536, { privateMode: true });
    const state = parse(stateBytes);
    const lockBytes = await readWorkerFile(path.join(control, 'lock/owner.json'), 65536, { privateMode: true });
    const lock = captureLockOwner(parse(lockBytes));
    const original = parse(await readWorkerFile(path.join(control, 'task-maintenance/admission.json'),
      1048576, { privateMode: true }));
    const backup = path.join(control, 'backup');
    const snapshot = await verifySnapshot(backup, { signal });
    if (state.operation !== 'restore' || state.operationId !== lock.operationId || state.project !== lock.project
      || snapshot.project !== state.project || snapshot.id !== state.backupId
      || snapshot.source.commit !== state.targetCommit || snapshot.runtime?.platform !== 'win32'
      || snapshot.runtime.task.name !== original.taskName) {
      throw new Error('Cold activation observation differs from its original restore state or archive.');
    }
    const expected = {
      version: 1, project: state.project, backup, backupId: snapshot.id,
      snapshotSha256: digest(Buffer.from(JSON.stringify(snapshot))), recoveryEngine: snapshot.recoveryEngine,
      controlIdentity: await windowsColdDirectoryIdentity(control),
      lockIdentity: await windowsColdDirectoryIdentity(path.join(control, 'lock')),
      lock, state, stateSha256: digest(stateBytes),
    };
    const prior = await inspectWindowsColdRestoreEvidence(control, expected,
      snapshot.runtime.task.configurationSha256, snapshot.source.commit, original.taskName,
      policyRecovery, completionRecovery ? 'released-prefix' : completedRuntime);
    const { guard, staging } = prior;
    const history = guard?.history;
    if (staging || !history || !['running', 'stopped'].includes(history.phase)
      || history.records[1]?.phase !== 'running' || !history.runtime) {
      throw new Error('Cold activation observation requires its acknowledged runtime prefix without staged ownership.');
    }
    const deadOwners = async () => {
      for (const owner of [lock, guard.record.owner,
        { pid: history.controllerPid, processIdentity: history.controllerIdentity },
        ...(!completedRuntime ? [{ pid: history.runtime.pid, processIdentity: history.runtime.identity }] : [])]) {
        if (await processIdentity(owner.pid) === owner.processIdentity) {
          throw new Error('Original cold activation owner, bridge or runtime is still alive.');
        }
      }
    };
    await deadOwners();
    await assertWindowsAdmission(control, admission, { signal });
    const controllerIdentity = await processIdentity(process.pid);
    if (!controllerIdentity) throw new Error('Original cold activation observer identity is unavailable.');
    const expectedObservation = {
      status: completionRecovery ? 'cold-completion-recovery' : completedRuntime ? 'cold-runtime-completed' : policyRecovery ? 'cold-policy-recovery'
        : history.phase === 'stopped' ? 'cold-activation-stopped' : 'cold-activation-inactive',
      mutationAuthority: policyRecovery || completionRecovery,
      operationId: lock.operationId, taskName: original.taskName, stateSha256: expected.stateSha256,
      ownerSha256: digest(guard.bytes), filesReceiptSha256: digest(guard.receipt.bytes),
      intentSha256: digest(guard.intent.bytes), historySha256: history.sha256, runtime: history.runtime,
    };
    let completion;
    let initialCompletionPrefix;
    const completionSteps = ['release-requested', 'released', 'policy-restore-requested',
      'permanent-policy-applied', 'policy-restored', 'enable-requested', 'enable-applied', 'complete'];
    const completionPhase = step => ({
      'permanent-policy-applied': 'policy-restore-requested', 'enable-applied': 'enable-requested',
    }[step] ?? step);
    const capturePrefix = async (phase, port, providers) => {
      const expectedNames = ['owner.json', 'files-restored.json', 'activation-intent.json',
        ...history.records.map(record => `activation-${record.phase}.json`),
        ...windowsColdCompletionPhases.slice(0, windowsColdCompletionPhases.indexOf(phase) + 1)
          .map(value => `completion-${value}.json`)].sort();
      if (!same((await readdir(path.join(control, 'recovery-lock'))).sort(), expectedNames)) {
        throw new Error('Cold completion recovery prefix inventory changed.');
      }
      return captureWindowsColdCompletionPrefix({
        control, running: history.records.at(-1), ownerSha256: expectedObservation.ownerSha256,
        receiptSha256: expectedObservation.filesReceiptSha256, intentSha256: expectedObservation.intentSha256,
        phase, port, providers,
      });
    };
    const captureCompletion = value => captureWindowsColdRuntimeCompletion({
      control, running: history.records.at(-1),
      ownerSha256: expectedObservation.ownerSha256, receiptSha256: expectedObservation.filesReceiptSha256,
      intentSha256: expectedObservation.intentSha256, port: value.port, providers: value.providers, value,
    });
    if (completionRecovery) {
      const phase = guard.completionPhases.at(-1);
      const bytes = await readWorkerFile(path.join(control, 'recovery-lock', `completion-${phase}.json`),
        1048576, { privateMode: true });
      const record = parse(bytes);
      initialCompletionPrefix = await capturePrefix(phase, record.port, record.providers);
      if (initialCompletionPrefix.sha256 !== digest(bytes)) throw new Error('Cold completion prefix changed before admission.');
      Object.assign(expectedObservation, { port: record.port, providers: record.providers, lease: 'released' });
    } else if (completedRuntime) {
      const bytes = await readWorkerFile(path.join(control, 'recovery-lock/completion-complete.json'),
        1048576, { privateMode: true });
      const last = parse(bytes);
      completion = await captureCompletion({
        status: 'runtime-policy-restored', step: 'complete', lease: 'released', completionSha256: digest(bytes),
        runtime: history.runtime, taskName: original.taskName, configuration: history.records.at(-1).configuration,
        definition: last.definition, enabled: last.enabled, port: last.port, providers: last.providers,
      });
      Object.assign(expectedObservation, {
        completionSha256: completion.completionSha256, port: completion.port,
        providers: completion.providers, lease: 'released',
      });
    }
    let policyBinding;
    let initialPolicy;
    const terminalFiles = completionRecovery ? await captureWindowsColdTerminalFiles(control) : null;
    if (terminalFiles && (terminalFiles.state.sha256 !== expected.stateSha256
      || terminalFiles.lock.sha256 !== digest(lockBytes))) {
      throw new Error('Cold terminal source files changed before native admission.');
    }
    if (policyRecovery) {
      const stopped = parse(await readWorkerFile(path.join(control, 'task-maintenance/task-stop-stopped.json'),
        4194304, { privateMode: true }));
      policyBinding = {
        operationId: lock.operationId, taskName: original.taskName,
        ownerSha256: expectedObservation.ownerSha256, filesReceiptSha256: expectedObservation.filesReceiptSha256,
        intentSha256: expectedObservation.intentSha256, historySha256: history.sha256, stateSha256: expected.stateSha256,
        sourceDefinition: history.records.at(-1).definition, targetDefinition: stopped.definition,
        securityDescriptor: history.records.at(-1).securityDescriptor,
      };
      initialPolicy = captureWindowsColdPolicyHistory({ binding: policyBinding, records: guard.policyRecords });
    }
    bridge = windowsControllerTransport({
      pwsh, refused, label: completedRuntime ? 'Native completed cold runtime observer' : 'Native inactive cold activation observer',
      args: ['-NoProfile', '-NonInteractive', '-File', script, '-Control', control,
        '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity, '-Recovery', '-ColdActivation',
        '-OwnerSha256', expectedObservation.ownerSha256, '-ReceiptSha256', expectedObservation.filesReceiptSha256,
        '-IntentSha256', expectedObservation.intentSha256, '-HistorySha256', expectedObservation.historySha256,
        ...(policyRecovery ? ['-ColdPolicyRecovery', '-PolicySha256', initialPolicy.sha256] : []),
        ...(completedRuntime ? ['-ColdCompletion', '-CompletionSha256',
          completionRecovery ? initialCompletionPrefix.sha256 : completion.completionSha256] : []),
        ...(completionRecovery ? ['-ColdCompletionRecovery'] : [])],
    });
    const ready = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'cold observation readiness');
    if (ready.type !== 'ready' || ready.pid !== bridge.child.pid || ready.control !== control
      || ready.controllerIdentity !== controllerIdentity || ready.processIdentity !== await processIdentity(ready.pid)) {
      throw new Error('Original cold activation observer bridge differs.');
    }
    const capture = async value => {
      const observation = captureWorkerFields(value, [...Object.keys(expectedObservation),
        ...(policyRecovery ? ['step', 'claimed', 'policySequence', 'policySha256'] : []),
        ...(completionRecovery ? ['phase', 'step', 'completionSha256'] : [])], 'cold activation observation');
      const runtime = Object.freeze(captureActivatedRuntime(observation.runtime));
      const base = Object.fromEntries(Object.keys(expectedObservation).map(key => [key, observation[key]]));
      if (!same(base, expectedObservation)) throw new Error('Original cold activation observation differs.');
      if (completionRecovery) {
        if (!completionSteps.includes(observation.step) || completionPhase(observation.step) !== observation.phase) {
          throw new Error('Unsupported cold completion recovery boundary.');
        }
        const prefix = await capturePrefix(observation.phase, observation.port, observation.providers);
        if (prefix.sha256 !== observation.completionSha256) throw new Error('Cold completion prefix acknowledgement changed.');
      } else if (completedRuntime) await captureCompletion(completion);
      if (policyRecovery) {
        const current = await inspectWindowsColdRestoreEvidence(control, expected,
          snapshot.runtime.task.configurationSha256, snapshot.source.commit, original.taskName, true);
        if (current.staging || !current.guard || !current.guard.bytes.equals(guard.bytes)) {
          throw new Error('Original cold policy recovery owner changed.');
        }
        const policy = captureWindowsColdPolicyHistory({ binding: policyBinding, records: current.guard.policyRecords });
        if (!['initial', 'requested', 'policy-applied', 'restored'].includes(observation.step)
          || (observation.step === 'policy-applied' ? 'requested' : observation.step) !== policy.step
          || observation.policySequence !== policy.sequence || observation.policySha256 !== policy.sha256
          || typeof observation.claimed !== 'boolean'
          || observation.claimed && !same(policy.owner, {
            controllerPid: process.pid, controllerIdentity, bridgePid: ready.pid, bridgeIdentity: ready.processIdentity,
          })) {
          throw new Error('Cold policy recovery acknowledgement differs from its durable owner journal.');
        }
      }
      return Object.freeze({ ...observation, runtime,
        ...(completedRuntime ? { providers: Object.freeze([...observation.providers]) } : {}) });
    };
    const observation = await capture(ready.value);
    if (completionRecovery && (observation.phase !== initialCompletionPrefix.record.phase
      || observation.completionSha256 !== initialCompletionPrefix.sha256)) {
      throw new Error('Cold completion recovery advanced before authority was acknowledged.');
    }
    let latest = observation;
    let closed = false;
    let finished = false;
    let busy = false;
    let sequence = 0;
    const request = async (method, requestSignal) => {
      requestSignal?.throwIfAborted();
      if (closed || busy) throw new Error('Cold activation observation is closed or busy.');
      if (method === 'archive' && (!policyRecovery || !latest.claimed || latest.step !== 'restored')) {
        throw new Error('Cold journal archival requires its original claimed restored policy.');
      }
      if (method === 'prepare-terminal' && (!completionRecovery || latest.step !== 'complete')) {
        throw new Error('Cold terminal handoff requires completed runtime policy.');
      }
      busy = true;
      try {
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        if (method !== 'close') await deadOwners();
        const archivedFiles = method === 'archive' ? await captureWindowsColdArchiveFiles({
          control, identity: guard.identity, signal: requestSignal,
          names: ['owner.json', 'files-restored.json', 'activation-intent.json',
            ...history.records.map(record => `activation-${record.phase}.json`),
            ...Array.from({ length: latest.policySequence }, (_, index) => `policy-${String(index + 1).padStart(6, '0')}.json`)],
        }) : null;
        const id = ++sequence;
        await bridge.wire.send({ id, method });
        const reply = captureWorkerFields(await bridge.wire.receive({ signal: requestSignal, timeoutMs: 30000 }),
          ['id', 'type', 'value', 'processIdentity'], 'cold observation acknowledgement');
        if (reply.id !== id || reply.type !== 'reply' || reply.processIdentity !== ready.processIdentity) {
          throw new Error('Original cold activation observer acknowledgement differs.');
        }
        if (method === 'close') {
          if (reply.value !== 'close') throw new Error('Cold activation observer close acknowledgement differs.');
          const result = await bridge.waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Cold activation observer did not close cleanly.');
          closed = true;
          bridge.wire.close();
          return;
        }
        if (method === 'prepare-terminal') {
          const result = captureWorkerFields(reply.value, ['status', 'operationId', 'sha256'], 'cold terminal handoff reply');
          const bytes = await readWorkerFile(path.join(control, 'cold-restore-terminal.json'), 1048576, { privateMode: true });
          if (result.status !== 'cold-terminal-prepared' || result.operationId !== lock.operationId
            || result.sha256 !== digest(bytes)) throw new Error('Cold terminal handoff acknowledgement differs.');
          const record = captureWindowsColdTerminalIntent(parse(bytes), {
            project: state.project, observation: latest, oldState: new TextDecoder('utf-8', { fatal: true }).decode(stateBytes),
            activationState: parse(guard.intent.bytes).state, rootIdentity: expected.controlIdentity,
            lockIdentity: expected.lockIdentity, recoveryIdentity: guard.identity, files: terminalFiles,
          });
          await assertWindowsAdmission(control, admission, { signal: requestSignal });
          return Object.freeze({ ...result, record });
        }
        if (method === 'archive') {
          const expectedArchive = {
            status: 'cold-policy-archived', mutationAuthority: false,
            operationId: lock.operationId, taskName: original.taskName, policySha256: latest.policySha256,
            archive: path.join(control, `cold-policy-${latest.policySha256}`), identity: guard.identity,
          };
          const archived = captureWorkerFields(reply.value, Object.keys(expectedArchive), 'cold journal archival');
          if (!same(archived, expectedArchive)) throw new Error('Cold journal archival acknowledgement differs.');
          const result = await bridge.waitForExit();
          if (result.code !== 0 || result.signal !== null) throw new Error('Cold archival bridge did not close cleanly.');
          closed = true;
          bridge.wire.close();
          await verifyWindowsColdArchiveFiles({
            control, archive: archived.archive, identity: guard.identity, files: archivedFiles, signal: requestSignal,
          });
          if (!(await readWorkerFile(path.join(control, 'state.json'), 65536, { privateMode: true })).equals(stateBytes)
            || !(await readWorkerFile(path.join(control, 'lock/owner.json'), 65536, { privateMode: true })).equals(lockBytes)) {
            throw new Error('Original restore state or lock changed during cold journal archival.');
          }
          await assertWindowsAdmission(control, admission, { signal: requestSignal });
          return Object.freeze({ ...archived, identity: Object.freeze({ ...archived.identity }) });
        }
        const current = await capture(reply.value);
        if (completionRecovery) {
          const next = completionSteps[Math.min(completionSteps.indexOf(latest.step) + 1, completionSteps.length - 1)];
          if (method === 'check' ? !same(current, latest)
            : method !== 'advance' || current.step !== next
              || (current.phase === latest.phase) !== (current.completionSha256 === latest.completionSha256)) {
            throw new Error('Cold completion recovery skipped an acknowledged write-ahead boundary.');
          }
          latest = current;
        }
        if (policyRecovery) {
          const nextStep = !latest.claimed ? latest.step : {
            initial: 'requested', requested: 'policy-applied', 'policy-applied': 'restored', restored: 'restored',
          }[latest.step];
          const increment = !latest.claimed || ['initial', 'policy-applied'].includes(latest.step) ? 1 : 0;
          if (method === 'check' ? !same(current, latest)
            : method !== 'advance' || !current.claimed || current.step !== nextStep
              || current.policySequence !== latest.policySequence + increment) {
            throw new Error('Cold policy recovery skipped its original claimed write-ahead transition.');
          }
          latest = current;
        }
        await assertWindowsAdmission(control, admission, { signal: requestSignal });
        return current;
      } catch (cause) {
        closed = true;
        throw await bridge.abandon(cause);
      } finally { busy = false; }
    };
    await assertWindowsAdmission(control, admission, { signal });
    return Object.freeze({
      observation,
      check: ({ signal: checkSignal } = {}) => request('check', checkSignal),
      ...(completionRecovery ? {
        identity: Object.freeze({ pid: ready.pid, processIdentity: ready.processIdentity }),
        advance: ({ signal: stepSignal } = {}) => request('advance', stepSignal),
        prepareTerminal: ({ signal: terminalSignal } = {}) => request('prepare-terminal', terminalSignal),
      } : {}),
      ...(policyRecovery ? {
        advance: ({ signal: stepSignal } = {}) => request('advance', stepSignal),
        archive: ({ signal: archiveSignal } = {}) => request('archive', archiveSignal),
      } : {}),
      async close() {
        if (busy) throw new Error('Cannot close an active cold activation observation.');
        if (finished) return;
        finished = true;
        const errors = [];
        try { if (!closed) await request('close'); } catch (error) { errors.push(error); }
        try { await admission.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Cold activation observation cleanup failed.');
      },
    });
  } catch (cause) {
    const failure = bridge ? await bridge.abandon(cause) : cause;
    try { await admission.close(); }
    catch (cleanup) { throw new AggregateError([failure, cleanup], 'Cold activation observation and cleanup failed.'); }
    throw failure;
  }
}
