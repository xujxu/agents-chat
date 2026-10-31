import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { runDeployment } from './transaction.mjs';
import { runStage } from './stage-runner.mjs';
import { assertLockOwner, captureLockOwner, loadState, releaseLock, writeState } from './state.mjs';
import { externalWorkerDirectory, syncWorkerDirectory } from './worker-files.mjs';
import { saveWorkerEngine } from './saved-worker-engine.mjs';
import { saveRecoveryEngine, verifyRecoveryEngine } from './saved-recovery-engine.mjs';
import { createWorkerOperation } from './worker-operation.mjs';
import { prepareLinuxFirstBuild } from './linux-first-build.mjs';
import { inspectTargetCompatibility } from './target-compatibility.mjs';
import { requireLinuxDeploymentSpace } from './linux-deployment-capacity.mjs';
import { createLinuxFirstUnit } from './linux-first-unit.mjs';
import { enableLinuxFirstUnit } from './linux-first-enablement.mjs';
import { activateLinuxFirstUnit } from './linux-first-activation.mjs';
import { inspectLinuxService } from './linux-service-inspection.mjs';
import { inspectLinuxConfiguration } from './linux-configuration.mjs';
import { captureLinuxDeploymentAcceptance } from './linux-deployment-acceptance.mjs';
import { publishDeploymentReceipt } from './deployment-receipt.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';
import { journalUncertain } from './evidence-journal.mjs';

export async function runLinuxFirstDeployment({
  installation, control, lock: supplied, git, environment = {}, port, deploymentBytes,
  revision, noPull = false, noInstall = false, waitSeconds = 120, timeoutSeconds = 1800,
  signal, onProgress,
}) {
  if (process.platform !== 'linux' || process.getuid() !== 0
    || installation?.identity?.runtime !== 'absent'
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(deploymentBytes) || deploymentBytes <= 0
    || !Number.isSafeInteger(waitSeconds) || waitSeconds <= 0
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0 || noInstall !== false) {
    throw new Error('Fresh Linux deployment requires absent runtime, root, dependencies, positive space and bounded verified activation.');
  }
  signal?.throwIfAborted();
  const lock = captureLockOwner(supplied);
  const { project, unit, executables } = installation.identity;
  if (lock.project !== project || control !== path.join(path.dirname(project), `.${path.basename(project)}.deployment`)) {
    throw new Error('Fresh deployment requires its original project and external control.');
  }
  const helperSource = fileURLToPath(new URL('./', import.meta.url));
  const native = { unit, project, npm: executables[0].file, node: executables[1].file };
  const timeoutMs = Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER);
  let state = null;
  let source;
  let target;
  let workers;
  let stages;
  let recovery;
  let built;
  let publication;
  let enabled;
  let active;
  let service;
  let acceptance;
  let result;
  const errors = [];
  const authority = async () => {
    await externalWorkerDirectory(control, project);
    await assertLockOwner(control, lock);
    if (!same(await loadState(control), state)) throw journalUncertain(new Error('Fresh deployment state changed.'));
  };
  const record = async (phase, context = {}) => {
    await authority();
    if (phase === 'preflight' && state) return;
    const next = {
      version: 1, operationId: lock.operationId, project, operation: 'deploy', phase,
      previousPhase: state?.phase ?? null, sourceCommit: source?.commit ?? null,
      targetCommit: target?.commit ?? null, backupId: null, priorRuntime: 'absent',
      runtimeIdentity: 'first-install-absent', startedAt: lock.createdAt,
      updatedAt: new Date().toISOString(), errorCode: context.errorCode ?? null,
    };
    await writeState(control, next);
    state = next;
    await syncWorkerDirectory(control);
    onProgress?.({ phase });
  };
  const noPriorSnapshot = async () => {
    throw journalUncertain(new Error('A first installation has no prior runtime or snapshot operation.'));
  };
  try {
    await authority();
    if (!same((await readdir(control)).sort(), ['lock'])) {
      throw new Error('Fresh deployment requires an empty transaction, not existing operation evidence.');
    }
    await installation.checkFreshRuntime();
    await record('preflight');
    const saved = await saveWorkerEngine({ control, project, operationId: lock.operationId, source: helperSource });
    workers = await createWorkerOperation({ control, lock, saved });
    result = await runDeployment({ operation: 'deploy', waitSeconds, timeoutSeconds, signal }, {
      record,
      async inspect({ signal: stageSignal }) {
        await authority();
        stages = await prepareLinuxFirstBuild({
          installation, control, lock, operation: workers, git, environment, signal: stageSignal,
        });
        source = await stages.inspect({ signal: stageSignal });
        return { exists: false, running: false, owned: true };
      },
      async resolveTarget({ signal: stageSignal }) {
        await authority();
        target = await stages.resolve({ options: { revision, noPull }, signal: stageSignal });
        return target;
      },
      async admit({ signal: stageSignal }) {
        await authority();
        const admitted = await inspectTargetCompatibility({
          project, commit: target.commit, nodeVersion: process.versions.node, platform: 'linux', signal: stageSignal,
        });
        if (admitted.configurationProfile !== installation.configuration.profile) {
          throw new Error('Fresh target requires a different configuration profile.');
        }
        const check = async ({ signal: checkSignal } = {}) => {
          await authority();
          await installation.checkFreshRuntime({ signal: checkSignal });
        };
        await check({ signal: stageSignal });
        return { compatibility: 'passed', check };
      },
      async capacity({ signal: stageSignal }) {
        await authority();
        await requireLinuxDeploymentSpace([[control, 80n * 1024n ** 2n], [project, BigInt(deploymentBytes)]]);
        stageSignal.throwIfAborted();
        recovery = await saveRecoveryEngine({ control, source: helperSource });
      },
      async stop({ recovering }) {
        await authority();
        if (!recovering) return noPriorSnapshot();
        if (active) return active.stopActivated();
        if (publication) return publication.checkInhibition({ signal: null });
        await installation.checkUninstalled({ signal: null });
      },
      snapshot: noPriorSnapshot, verifySnapshot: noPriorSnapshot, rotate: noPriorSnapshot,
      async selectSource({ signal: stageSignal }) {
        await authority();
        await stages.select({ target, signal: stageSignal });
      },
      async dependencies({ signal: stageSignal }) {
        await authority();
        await stages.npm({ stage: 'dependencies', commit: target.commit, signal: stageSignal });
      },
      async build({ signal: stageSignal }) {
        await authority();
        built = await stages.npm({ stage: 'build', commit: target.commit, signal: stageSignal });
      },
      async configure({ signal: stageSignal }) {
        await authority();
        await installation.checkUninstalled({ signal: stageSignal });
        await built.source.check({ signal: stageSignal });
        await built.artifacts.check({ signal: stageSignal });
        await verifyRecoveryEngine({ control, manifestSha256: recovery.manifestSha256 });
        await workers.seal();
        const context = { installation, control, lock, signal: stageSignal };
        publication = await createLinuxFirstUnit(context);
        enabled = await enableLinuxFirstUnit({ ...context, publication });
      },
      async start({ recovering, signal: stageSignal }) {
        if (recovering) return noPriorSnapshot();
        await authority();
        active = await activateLinuxFirstUnit({
          installation, publication, enabled, control, lock, signal: stageSignal,
        });
        service = await inspectLinuxService(native);
        if (!same(service.identity, active.identity)) throw journalUncertain(new Error('First activated generation changed.'));
      },
      async verify({ signal: stageSignal }) {
        await authority();
        await installation.configuration.check({ signal: stageSignal });
        const configuration = await inspectLinuxConfiguration({
          service, profile: installation.configuration.profile, signal: stageSignal,
        });
        if (!same(configuration.providers, installation.configuration.providers)) {
          throw new Error('Fresh runtime authentication providers differ from the admitted configuration.');
        }
        acceptance = await captureLinuxDeploymentAcceptance({
          service, configuration, source: built.source, artifacts: built.artifacts, port, waitSeconds, signal: stageSignal,
        });
        await installation.configuration.check({ signal: stageSignal });
      },
    });
    await runStage('publish-receipt', stageSignal => publishDeploymentReceipt({
      control, lock, ...acceptance, signal: stageSignal,
    }), { timeoutMs, signal });
    await authority();
    await verifyRecoveryEngine({ control, manifestSha256: recovery.manifestSha256 });
    await active.retire({ acceptance });
    await workers.retire();
    await releaseLock(control, lock);
  } catch (error) {
    errors.push(error);
    if (state?.phase === 'preflight') {
      try {
        await record(hasUnsettledWorker(error) ? 'blocked' : 'recovery-required', {
          errorCode: typeof error.code === 'string' ? error.code : 'DEPLOYMENT_FIRST_INSTALL_FAILED',
        });
      } catch (recording) { errors.push(journalUncertain(recording)); }
    }
  }
  const closed = await Promise.allSettled([service?.close(), active?.close(), enabled?.close(), publication?.close(), workers?.close()]);
  errors.push(...closed.filter(value => value.status === 'rejected').map(value => journalUncertain(value.reason)));
  if (errors.length) {
    const cause = errors.length === 1 ? errors[0] : new AggregateError(errors, 'Fresh deployment and authority cleanup failed.');
    throw Object.assign(new Error('First Linux deployment failed; no previous backup exists. Retain and inspect the original operation evidence.', { cause }), {
      code: errors.some(hasUnsettledWorker) ? 'DEPLOYMENT_WORKER_UNSETTLED'
        : typeof cause.code === 'string' ? cause.code : 'DEPLOYMENT_FIRST_INSTALL_FAILED',
      recoveryAllowed: false, backupCreated: false,
      nextAction: 'Inspect the saved worker/service evidence before continuing; restore cannot recover a first installation without a previous backup.',
    });
  }
  return result;
}
