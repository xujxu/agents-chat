import { lstat, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { runDeployment } from './transaction.mjs';
import { runStage } from './stage-runner.mjs';
import { assertLockOwner, captureLockOwner, loadState, releaseLock, writeState } from './state.mjs';
import { externalWorkerDirectory, syncWorkerDirectory } from './worker-files.mjs';
import { saveWorkerEngine } from './saved-worker-engine.mjs';
import { saveRecoveryEngine, verifyRecoveryEngine } from './saved-recovery-engine.mjs';
import { retireRecoveryEngines } from './recovery-engine-retention.mjs';
import { createWorkerOperation } from './worker-operation.mjs';
import { prepareLinuxSourceBuild } from './linux-source-build.mjs';
import { admitLinuxCompatibility } from './linux-compatibility.mjs';
import { inspectSnapshotScope } from './snapshot-scope.mjs';
import { prepareGitObjects } from './git-objects.mjs';
import { createLinuxServiceSnapshot } from './linux-snapshot.mjs';
import { verifySnapshot } from './snapshot.mjs';
import { reconcileSnapshotSlots, rotateSnapshot } from './snapshot-rotation.mjs';
import { stopLinuxService } from './linux-service-stop.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { inspectLinuxConfiguration } from './linux-configuration.mjs';
import { waitLinuxReadiness } from './linux-readiness.mjs';
import { captureLinuxDeploymentAcceptance } from './linux-deployment-acceptance.mjs';
import { publishDeploymentReceipt } from './deployment-receipt.mjs';
import { closeRejectedLinuxPreflight } from './linux-preflight-refusal.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';
import { journalUncertain } from './evidence-journal.mjs';
import { inspectCurrentLinuxDeployment } from './linux-current-deployment.mjs';

export async function runLinuxLiveDeployment({
  service, control, lock: supplied, git, environment, port, deploymentBytes,
  operation: kind = 'update', revision, noPull = false, noInstall = false,
  waitSeconds = 120, timeoutSeconds = 1800, signal, onProgress,
}) {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Live Linux deployment requires a root controller.');
  if (!['deploy', 'update'].includes(kind) || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(deploymentBytes) || deploymentBytes <= 0
    || !Number.isSafeInteger(waitSeconds) || waitSeconds <= 0
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Live deployment requires deploy/update, an explicit port, positive build space and bounded verified activation.');
  }
  const lock = captureLockOwner(supplied);
  const project = service.identity.runtime.project;
  const native = { unit: service.identity.runtime.unit, project,
    npm: service.identity.executables[0].file, node: service.identity.executables[1].file };
  let state;
  let previousState;
  let current;
  let source;
  let target;
  let admission;
  let buildEnvironment;
  let workers;
  let stages;
  let stopped;
  let active;
  let built;
  let accepted;
  let recovery;
  let sealed = false;
  let activationAttempted = false;
  let result;
  const errors = [];
  const authority = async () => {
    await externalWorkerDirectory(control, project);
    if (lock.project !== project) throw new Error('Deployment lock differs from installed project.');
    await assertLockOwner(control, lock);
    if (state && !same(await loadState(control), state)) throw journalUncertain(new Error('Deployment state changed.'));
  };
  const record = async (phase, context = {}) => {
    await authority();
    if (phase === 'preflight' && state) return;
    const next = {
      version: 1, operationId: lock.operationId, project, operation: kind, phase,
      previousPhase: state?.phase ?? null, sourceCommit: source?.commit ?? null,
      targetCommit: target?.commit ?? null,
      backupId: phase === 'already-current' ? previousState.backupId : context.snapshot?.id ?? state?.backupId ?? null,
      priorRuntime: 'running', runtimeIdentity: service.identity.runtime.invocationId,
      startedAt: lock.createdAt, updatedAt: new Date().toISOString(), errorCode: context.errorCode ?? null,
    };
    await writeState(control, next);
    state = next;
    await syncWorkerDirectory(control);
    onProgress?.({ phase });
  };
  const seal = async () => {
    if (!sealed) { await workers.seal(); sealed = true; }
  };
  const retire = async () => {
    await authority();
    await stopped.retire();
    await workers.retire();
    if (state.phase === 'accepted') {
      await runStage('retire-engines', stageSignal => retireRecoveryEngines({
        control, lock, current: recovery, signal: stageSignal,
      }), { timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER), signal });
    }
    await releaseLock(control, lock);
  };
  try {
    await authority();
    await service.check();
    previousState = await loadState(control);
    await record('preflight');
    const saved = await saveWorkerEngine({ control, project, operationId: lock.operationId,
      source: fileURLToPath(new URL('./', import.meta.url)) });
    workers = await createWorkerOperation({ control, lock, saved });
    result = await runDeployment({ operation: kind, noInstall, waitSeconds, timeoutSeconds, signal }, {
      record,
      async inspect({ signal: stageSignal }) {
        await authority();
        stages = await prepareLinuxSourceBuild({ service, operation: workers, git, environment, signal: stageSignal });
        source = await stages.inspect({ signal: stageSignal });
        return { exists: true, running: true, owned: true };
      },
      async resolveTarget({ signal: stageSignal }) {
        await authority();
        target = await stages.resolve({ options: { revision, noPull }, signal: stageSignal });
        return target;
      },
      async admit({ signal: stageSignal }) {
        await authority();
        admission = await admitLinuxCompatibility({ service, operation: workers, commit: target.commit, signal: stageSignal });
        buildEnvironment = admission.configuration.buildEnvironment(environment);
        if (kind === 'update' && source.commit === target.commit) {
          current = await inspectCurrentLinuxDeployment({
            state: previousState, service, configuration: admission.configuration, control,
            commit: target.commit, port, waitSeconds, signal: stageSignal,
          });
        }
        return { ...admission, current: current?.current };
      },
      async capacity({ signal: stageSignal }) {
        await authority();
        const slots = await reconcileSnapshotSlots(control, { project });
        if (!['empty', 'retained'].includes(slots.status)) throw new Error('Unfinished snapshot rotation requires recovery before downtime.');
        const scope = await inspectSnapshotScope({ project, signal: stageSignal });
        const objects = await prepareGitObjects({ project, commit: source.commit, signal: stageSignal });
        let bytes = BigInt(scope.snapshotBytes) + BigInt(objects.bytes) + 80n * 1024n ** 2n;
        const external = new Set([...service.identity.sources, ...admission.configuration.files]
          .filter(file => !file.path.startsWith(`${project}${path.sep}`)).map(file => file.path));
        for (const file of external) {
          stageSignal.throwIfAborted();
          try { bytes += (await lstat(file, { bigint: true })).size; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const budgets = new Map();
        for (const [directory, required] of [[control, bytes], [project, BigInt(deploymentBytes)]]) {
          const { dev } = await stat(directory, { bigint: true });
          const space = await statfs(directory, { bigint: true });
          const prior = budgets.get(dev) ?? { required: 0n, available: space.bavail * space.bsize };
          prior.required += required;
          budgets.set(dev, prior);
        }
        if ([...budgets.values()].some(value => value.required > value.available)) {
          throw new Error('Insufficient space for complete backup and declared build budget.');
        }
        recovery = await saveRecoveryEngine({ control, source: fileURLToPath(new URL('./', import.meta.url)), allowVersionChange: true });
      },
      async stop({ recovering }) {
        await authority();
        if (recovering) {
          if (!stopped) throw journalUncertain(new Error('Original deployment stop did not complete.'));
          return activationAttempted ? stopped.stopActivated() : stopped.checkStopped();
        }
        await verifyRecoveryEngine({ control, manifestSha256: recovery.manifestSha256 });
        stopped = await stopLinuxService({ ...native, control, lock });
      },
      async snapshot({ signal: stageSignal }) {
        await authority();
        return createLinuxServiceSnapshot({ service, stopped, configuration: admission.configuration,
          destination: path.join(control, 'staging'), id: lock.operationId,
          source: { commit: source.commit, provenance: 'observed' }, signal: stageSignal,
          recoveryEngine: recovery.manifestSha256 });
      },
      async verifySnapshot({ snapshot, signal: stageSignal }) {
        await authority();
        if (!same(await verifySnapshot(path.join(control, 'staging'), { signal: stageSignal }), snapshot)) {
          throw new Error('Staged backup changed.');
        }
      },
      async rotate() {
        await authority();
        await rotateSnapshot(control, { project });
      },
      async selectSource({ signal: stageSignal }) {
        await authority();
        await stages.select({ target, stopped, signal: stageSignal });
      },
      async dependencies({ signal: stageSignal }) {
        await authority();
        await stages.npm({ stage: 'dependencies', commit: target.commit, stopped,
          environment: buildEnvironment, signal: stageSignal });
      },
      async build({ signal: stageSignal }) {
        await authority();
        built = await stages.npm({ stage: 'build', commit: target.commit, stopped,
          environment: buildEnvironment, signal: stageSignal });
      },
      async configure({ signal: stageSignal }) {
        await authority();
        await stopped.checkStopped();
        await admission.configuration.checkFiles({ signal: stageSignal });
        await service.checkPolicy({ stopped: true, inhibited: true });
        await built.source.check({ signal: stageSignal });
        await built.artifacts.check({ signal: stageSignal });
      },
      async start({ activationPurpose }) {
        await authority();
        await seal();
        activationAttempted = true;
        await stopped.activate({ purpose: activationPurpose });
        active = await inspectLinuxService(native);
      },
      async verify({ recovering, signal: stageSignal }) {
        await authority();
        await admission.configuration.checkFiles({ signal: stageSignal });
        const configuration = await inspectLinuxConfiguration({
          service: active, profile: admission.configuration.profile, signal: stageSignal,
        });
        if (recovering) {
          await waitLinuxReadiness({ service: active, port, providers: configuration.providers, waitSeconds, signal: stageSignal });
        } else {
          accepted = await captureLinuxDeploymentAcceptance({
            service: active, configuration, source: built.source, artifacts: built.artifacts, port, waitSeconds, signal: stageSignal,
          });
        }
      },
    });
    if (result.status === 'already-current') {
      await seal();
      await runStage('verify-current', async stageSignal => {
        await authority();
        await current.check({ signal: stageSignal });
        await record('already-current');
      }, { timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER), signal });
      await workers.retire();
      await releaseLock(control, lock);
    } else {
      await runStage('publish-receipt', stageSignal => publishDeploymentReceipt({
        control, lock, ...accepted, signal: stageSignal,
      }), { timeoutMs: Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER), signal });
      await retire();
    }
  } catch (error) {
    errors.push(error);
    try {
      if (!hasUnsettledWorker(error) && state?.phase === 'preflight' && workers && !sealed) {
        await closeRejectedLinuxPreflight({ control, lock, service, operation: workers });
      } else if (!hasUnsettledWorker(error) && state?.phase === 'prior-runtime-restored') {
        await retire();
      }
    } catch (cleanup) { errors.push(cleanup); }
  }
  const closed = await Promise.allSettled([active?.close(), stopped?.close(), workers?.close()]);
  errors.push(...closed.filter(value => value.status === 'rejected').map(value => journalUncertain(value.reason)));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw journalUncertain(new AggregateError(errors, 'Linux deployment and authority cleanup failed.'));
  return result;
}
