import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { assertLockOwner, captureLockOwner, loadState } from './state.mjs';
import { canonicalWorkerDirectory } from './worker-files.mjs';
import { journalUncertain } from './evidence-journal.mjs';
import { inspectLinuxRuntimeAccount } from './linux-runtime.mjs';
import { inspectLinuxServicePolicy } from './linux-service-inspection.mjs';
import { linuxSystemdProperties } from './linux-systemd.mjs';
import { activateLinuxService } from './linux-service-activation.mjs';
import { readDeploymentReceipt } from './deployment-receipt.mjs';

const identity = info => ({ dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode });
const runtimeKeys = ['MainPID', 'ActiveState', 'SubState', 'ControlGroup', 'InvocationID'];
const receiptIdentity = info => ({ ...identity(info), size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });

export async function activateLinuxFirstUnit({ installation, publication, enabled, control, lock: supplied, signal }) {
  let lockHandle;
  let activated;
  let receiptHandle;
  let receiptInfo;
  let retirementReceipt;
  let retirementAttempted = false;
  let closed = false;
  let busy = false;
  const closeHandles = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([activated?.close(), lockHandle?.close(), receiptHandle?.close()]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw journalUncertain(new AggregateError(errors, 'First activation handle cleanup failed.'));
  };
  const close = async () => {
    if (busy) throw journalUncertain(new Error('Cannot close first activation while checking its owned generation.'));
    await closeHandles();
  };
  try {
    signal?.throwIfAborted();
    const lock = captureLockOwner(supplied);
    const { project, unit, account, executables } = installation.identity;
    if (process.platform !== 'linux' || process.getuid() !== 0 || installation.identity.runtime !== 'absent'
      || lock.project !== project || control !== path.join(path.dirname(project), `.${path.basename(project)}.deployment`)
      || publication.status !== 'configured-inhibited' || publication.identity.project !== project
      || publication.identity.unit !== unit || enabled.status !== 'enabled-inhibited' || enabled.identity.unit !== unit) {
      throw new Error('First activation requires its original fresh installation, publication and enablement.');
    }
    const state = await loadState(control);
    if (state?.project !== project || state.operationId !== lock.operationId || state.operation !== 'deploy'
      || state.priorRuntime !== 'absent' || state.phase !== 'activating' || state.backupId !== null
      || !state.targetCommit || state.errorCode !== null) {
      throw new Error('First activation requires matching fresh activating-phase admission.');
    }
    const npm = executables[0].file;
    const node = executables[1].file;
    const inhibition = `/etc/systemd/system/${unit}.d/90-agents-chat-deployment.conf`;
    const group = `/sys/fs/cgroup/system.slice/${unit}`;
    const rootInfo = (await canonicalWorkerDirectory(control, { privateMode: true })).info;
    const lockDirectory = path.join(control, 'lock');
    const lockInfo = (await canonicalWorkerDirectory(lockDirectory, { privateMode: true })).info;
    const lockFile = path.join(lockDirectory, 'owner.json');
    lockHandle = await open(lockFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const originalLock = await lockHandle.stat();
    const checkAuthority = async ({ retiring = false } = {}) => {
      if (closed) throw new Error('First activation authority is closed.');
      await assertLockOwner(control, lock);
      const root = await canonicalWorkerDirectory(control, { privateMode: true });
      const directory = await canonicalWorkerDirectory(lockDirectory, { privateMode: true });
      const retained = await lockHandle.stat();
      if (!same(identity(root.info), identity(rootInfo)) || !same(identity(directory.info), identity(lockInfo))
        || !same(identity(retained), identity(originalLock))
        || !same(identity(await lstat(lockFile)), identity(originalLock)) || retained.nlink !== 1) {
        throw new Error('Original first activation lock or transaction changed.');
      }
      const current = await loadState(control);
      if (retiring) {
        if (!retirementReceipt || current?.phase !== 'accepted'
          || !['activating', 'activation-unverified'].includes(current.previousPhase)
          || Object.keys(state).filter(key => !['phase', 'previousPhase', 'updatedAt'].includes(key))
            .some(key => current[key] !== state[key])
          || !same(await readDeploymentReceipt(control, project), retirementReceipt)
          || !same(receiptIdentity(await lstat(path.join(control, 'deployment.json'))), receiptInfo)
          || !same(receiptIdentity(await receiptHandle.stat()), receiptInfo)
          || (await receiptHandle.stat()).nlink !== 1) {
          throw new Error('First retirement acceptance or original deployment receipt changed.');
        }
        await installation.checkIdentity({ signal: null });
      } else {
        if (!same(current, state)) throw new Error('Original first activation transaction changed.');
        await publication.checkSources({ signal: null });
        await enabled.checkFiles();
      }
      return current;
    };
    const checkInhibition = async () => {
      await checkAuthority();
      await publication.checkInhibition({ signal: null });
    };
    const unstarted = async observed => {
      if (observed.MainPID !== '0' || observed.ActiveState !== 'inactive' || observed.SubState !== 'dead'
        || observed.ControlGroup || observed.InvocationID) throw new Error('First unit is no longer genuinely unstarted.');
      try { await lstat(group); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      throw new Error('Existing first-unit cgroup requires inspection before activation.');
    };
    await checkInhibition();
    const configuration = await inspectLinuxServicePolicy(unit, npm);
    if (!same(configuration, publication.identity.configuration)) {
      throw new Error('First unit policy changed after publication.');
    }
    await unstarted(configuration.state);
    const runtime = await inspectLinuxRuntimeAccount({ unit, project });
    if (runtime.mainPid !== 0 || runtime.processIdentity !== null || runtime.invocationId !== ''
      || runtime.activeState !== 'inactive'
      || !same(Object.fromEntries(Object.keys(account).map(name => [name, runtime[name]])), account)) {
      throw new Error('First unit does not retain its genuine inactive runtime account.');
    }
    const checkPolicy = async ({ inhibited = false, stopped = false } = {}) => {
      await installation.checkIdentity({ signal: null });
      const current = await inspectLinuxServicePolicy(unit, npm);
      if (Object.entries(configuration.state).some(([name, value]) => !runtimeKeys.includes(name)
        && current.state[name] !== (name === 'RefuseManualStart' ? inhibited ? 'yes' : 'no'
          : name === 'Restart' ? inhibited ? 'no' : 'on-failure' : value))
        || !same(current.drops, inhibited ? [inhibition] : [])
        || !same(current.conditions, inhibited ? [['ConditionPathExists', false, true, inhibition]] : [])) {
        throw new Error('Original first-unit activation policy changed.');
      }
      const enablement = await linuxSystemdProperties(unit, ['UnitFileState', 'Job']);
      // systemctl show renders a zero job ID as an empty property value.
      if (enablement.UnitFileState !== 'enabled' || stopped && enablement.Job !== '') {
        throw Object.assign(new Error('First-unit enablement or pending job changed.'), { observed: enablement });
      }
      if (stopped) await unstarted(current.state);
    };
    const service = Object.freeze({
      identity: { kind: 'first-install', runtime, configuration, executables },
      checkPolicy,
      async checkInhibited() {
        await checkPolicy({ inhibited: true, stopped: true });
        return { stopped: true };
      },
    });
    activated = await activateLinuxService({
      control, lock, unit, project, npm, node, service, inhibition, checkAuthority, checkInhibition, signal,
      startup: enabled.identity,
      async checkMaintenanceEvidence() {
        await publication.checkSources({ signal: null });
        await enabled.checkFiles();
      },
      async closeForRetirement() {
        const results = await Promise.allSettled([closeHandles(), publication.close(), enabled.close()]);
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'First retirement authority cleanup failed.');
      },
    }, 'deployment');
    if (signal?.aborted) {
      await activated.stop();
      signal.throwIfAborted();
    }
    return Object.freeze({
      status: activated.status, identity: activated.identity, close,
      async stopActivated() {
        if (closed || busy || retirementAttempted) throw journalUncertain(new Error('First activation stop requires available live authority.'));
        busy = true;
        try { return await activated.stop(); }
        finally { busy = false; }
      },
      async retire({ acceptance } = {}) {
        if (closed || busy || retirementAttempted || typeof acceptance?.checkAccepted !== 'function') {
          throw journalUncertain(new Error('First retirement requires original live authority and captured acceptance.'));
        }
        busy = true;
        retirementAttempted = true;
        try {
          retirementReceipt = await readDeploymentReceipt(control, project);
          if (!retirementReceipt || retirementReceipt.operationId !== lock.operationId
            || retirementReceipt.identity.source !== state.targetCommit
            || retirementReceipt.identity.service !== createHash('sha256').update(JSON.stringify(activated.identity)).digest('hex')
            || !same(retirementReceipt.identity, acceptance.identity)
            || !same(await acceptance.checkAccepted(), retirementReceipt.identity)) {
            throw new Error('First retirement requires its published, still-verified deployment receipt.');
          }
          receiptHandle = await open(path.join(control, 'deployment.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
          receiptInfo = receiptIdentity(await receiptHandle.stat());
          await checkAuthority({ retiring: true });
          await activated.retire();
        } catch (error) { throw journalUncertain(error); }
        finally { busy = false; }
      },
    });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw journalUncertain(new AggregateError([error, cleanup])); }
    throw journalUncertain(error);
  }
}
