import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { runDeployment } from './transaction.mjs';
import { runStage } from './stage-runner.mjs';
import { assertLockOwner, captureLockOwner, loadState, writeState } from './state.mjs';
import { externalWorkerDirectory } from './worker-files.mjs';
import { saveWorkerEngine } from './saved-worker-engine.mjs';
import { saveRecoveryEngine, verifyRecoveryEngine } from './saved-recovery-engine.mjs';
import { createWorkerOperation } from './worker-operation.mjs';
import { assertWindowsFirstInstallScope } from './windows-first-install.mjs';
import { assertWindowsFirstConfiguration, inspectWindowsConfiguration } from './windows-configuration.mjs';
import { prepareWindowsFirstBuild } from './windows-first-build.mjs';
import { prepareWindowsFirstRuntime } from './windows-first-runtime.mjs';
import { inspectWindowsManagedTask } from './windows-managed-task.mjs';
import { captureWindowsDeploymentAcceptance } from './windows-deployment-acceptance.mjs';
import { inspectTargetCompatibility } from './target-compatibility.mjs';
import { requireLinuxDeploymentSpace as requireDeploymentSpace } from './linux-deployment-capacity.mjs';
import { publishDeploymentReceipt } from './deployment-receipt.mjs';
import { hasUnsettledWorker } from './worker-errors.mjs';
import { journalUncertain } from './evidence-journal.mjs';

export async function runWindowsFirstDeployment({
  scope, configuration, control, lock: supplied, node, npmCli, git, pwsh, environment = {}, port, deploymentBytes,
  revision, noPull = false, noInstall = false, waitSeconds = 120, timeoutSeconds = 1800,
  logonType = 'Interactive', triggerType = 'AtLogOn', signal, onProgress,
}) {
  if (process.platform !== 'win32' || noInstall !== false
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(deploymentBytes) || deploymentBytes <= 0
    || !Number.isSafeInteger(waitSeconds) || waitSeconds <= 0
    || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0
    || !['Interactive', 'S4U'].includes(logonType) || !['AtLogOn', 'AtStartup'].includes(triggerType)
    || onProgress !== undefined && typeof onProgress !== 'function') {
    throw new Error('First Windows deployment requires dependencies, supported task policy, positive space and bounded verified activation.');
  }
  signal?.throwIfAborted();
  const original = await assertWindowsFirstInstallScope(scope, { controlEvidence: false, signal });
  await assertWindowsFirstConfiguration(configuration, { scope, signal });
  const project = original.project;
  const lock = captureLockOwner(supplied);
  if (lock.project !== project || pwsh !== scope.identity.pwsh
    || control !== path.join(path.dirname(project), `.${path.basename(project)}.deployment`)) {
    throw new Error('First deployment requires its original Windows project, lock and controller.');
  }
  const helperSource = fileURLToPath(new URL('./', import.meta.url));
  const timeoutMs = Math.min(timeoutSeconds * 1000, Number.MAX_SAFE_INTEGER);
  let state = null;
  let source;
  let target;
  let workers;
  let stages;
  let recovery;
  let built;
  let published;
  let active;
  let activeConfiguration;
  let completed = false;
  let receiptPublished = false;
  let result;
  const errors = [];
  const authority = async () => {
    await externalWorkerDirectory(helperSource, project);
    await externalWorkerDirectory(control, project);
    await assertLockOwner(control, lock);
    if (!same(await loadState(control), state)) throw journalUncertain(new Error('Original first deployment state changed.'));
  };
  const record = async (phase, context = {}) => {
    await authority();
    if (phase === 'preflight' && state) return;
    if (state?.phase === 'accepted') {
      throw journalUncertain(new Error('Retain original first acceptance for completion recovery; it cannot be rewritten.'));
    }
    const next = {
      version: 1, operationId: lock.operationId, project, operation: 'deploy', phase,
      previousPhase: state?.phase ?? null, sourceCommit: source?.commit ?? null, targetCommit: target?.commit ?? null,
      backupId: null, priorRuntime: 'absent', runtimeIdentity: 'first-install-absent',
      startedAt: lock.createdAt, updatedAt: new Date().toISOString(), errorCode: context.errorCode ?? null,
    };
    await writeState(control, next);
    state = next;
    onProgress?.({ phase });
  };
  const noPriorSnapshot = async () => {
    throw journalUncertain(new Error('First Windows deployment has no prior runtime or snapshot authority.'));
  };
  try {
    await authority();
    if (!same((await readdir(control)).sort(), ['lock', 'windows-admission.lock'])) {
      throw new Error('First deployment requires an empty transaction rather than previous operation evidence.');
    }
    await scope.checkFreshRuntime({ signal });
    await record('preflight');
    const saved = await saveWorkerEngine({ control, project, operationId: lock.operationId, source: helperSource });
    workers = await createWorkerOperation({ control, lock, saved });
    result = await runDeployment({ operation: 'deploy', waitSeconds, timeoutSeconds, signal }, {
      record,
      async inspect({ signal: stageSignal }) {
        await authority();
        stages = await prepareWindowsFirstBuild({
          scope, configuration, control, lock, operation: workers, node, npmCli, git, pwsh, environment, signal: stageSignal,
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
          project, commit: target.commit, git, nodeVersion: process.versions.node, platform: 'win32', signal: stageSignal,
        });
        if (admitted.configurationProfile !== configuration.profile) {
          throw new Error('First target requires a different configuration profile.');
        }
        const check = async ({ signal: checkSignal } = {}) => {
          await authority();
          await scope.checkFreshRuntime({ signal: checkSignal });
          await assertWindowsFirstConfiguration(configuration, { scope, signal: checkSignal });
        };
        await check({ signal: stageSignal });
        return { compatibility: 'passed', check };
      },
      async capacity({ signal: stageSignal }) {
        await authority();
        await requireDeploymentSpace([[control, 80n * 1024n ** 2n], [project, BigInt(deploymentBytes)]]);
        stageSignal.throwIfAborted();
        recovery = await saveRecoveryEngine({ control, source: helperSource });
      },
      async stop({ recovering }) {
        await authority();
        if (!recovering) return noPriorSnapshot();
        if (published) await published.close();
        else await scope.checkUninstalled({ signal: null });
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
        await verifyRecoveryEngine({ control, manifestSha256: recovery.manifestSha256 });
        await workers.seal();
        published = await prepareWindowsFirstRuntime({
          scope, configuration, control, lock, built, node, pwsh, environment, port, signal: stageSignal,
        });
        await published.registerTask({ logonType, triggerType, signal: stageSignal });
        await published.prepareActivation({ signal: stageSignal });
      },
      async start({ recovering, signal: stageSignal }) {
        if (recovering) return noPriorSnapshot();
        await authority();
        await published.activate({ signal: stageSignal });
      },
      async verify({ signal: stageSignal }) {
        await authority();
        await published.prepareCompletion({ waitSeconds, signal: stageSignal });
      },
    });
    await runStage('complete-first-runtime', async stageSignal => {
      await authority();
      await published.complete({ signal: stageSignal });
      completed = true;
      await published.close();
    }, { timeoutMs, signal });
    await runStage('publish-receipt', async stageSignal => {
      await authority();
      active = await inspectWindowsManagedTask({ project, taskName: original.taskName, pwsh, signal: stageSignal });
      activeConfiguration = await inspectWindowsConfiguration({
        scope: active, pwsh, profile: configuration.profile, signal: stageSignal,
      });
      const accepted = await captureWindowsDeploymentAcceptance({
        scope: active, configuration: activeConfiguration, source: built.source, artifacts: built.artifacts,
        port, waitSeconds, signal: stageSignal,
      });
      await publishDeploymentReceipt({ control, lock, ...accepted, signal: stageSignal });
      receiptPublished = true;
      await verifyRecoveryEngine({ control, manifestSha256: recovery.manifestSha256 });
    }, { timeoutMs, signal });
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
  const closed = await Promise.allSettled([
    activeConfiguration?.close(), active?.close(), published?.close(), workers?.close(),
  ]);
  errors.push(...closed.filter(value => value.status === 'rejected').map(value => journalUncertain(value.reason)));
  const closeoutRequired = completed && receiptPublished && !errors.some(hasUnsettledWorker);
  if (errors.length) {
    const cause = errors.length === 1 ? errors[0] : new AggregateError(errors, 'First deployment and authority cleanup failed.');
    throw Object.assign(new Error('First Windows deployment failed; no previous backup exists. Retain original operation evidence.', { cause }), {
      code: errors.some(hasUnsettledWorker) ? 'DEPLOYMENT_WORKER_UNSETTLED'
        : typeof cause.code === 'string' ? cause.code : 'DEPLOYMENT_FIRST_INSTALL_FAILED',
      recoveryAllowed: false, backupCreated: false, closeoutRequired,
      ...(closeoutRequired ? { operationId: lock.operationId, recoveryEngine: recovery.manifestSha256 } : {}),
    });
  }
  return Object.freeze({ ...result, closeoutRequired, recoveryEngine: recovery.manifestSha256 });
}
