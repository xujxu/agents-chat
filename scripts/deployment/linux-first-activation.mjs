import { constants } from 'node:fs';
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

const identity = info => ({ dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode });
const runtimeKeys = ['MainPID', 'ActiveState', 'SubState', 'ControlGroup', 'InvocationID'];

export async function activateLinuxFirstUnit({ installation, publication, enabled, control, lock: supplied, signal }) {
  let lockHandle;
  let activated;
  let closed = false;
  let busy = false;
  const close = async () => {
    if (busy) throw journalUncertain(new Error('Cannot close first activation while checking its owned generation.'));
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([activated?.close(), lockHandle?.close()]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw journalUncertain(new AggregateError(errors, 'First activation handle cleanup failed.'));
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
    const checkAuthority = async () => {
      if (closed) throw new Error('First activation authority is closed.');
      await assertLockOwner(control, lock);
      const root = await canonicalWorkerDirectory(control, { privateMode: true });
      const directory = await canonicalWorkerDirectory(lockDirectory, { privateMode: true });
      const retained = await lockHandle.stat();
      if (!same(identity(root.info), identity(rootInfo)) || !same(identity(directory.info), identity(lockInfo))
        || !same(identity(retained), identity(originalLock))
        || !same(identity(await lstat(lockFile)), identity(originalLock)) || retained.nlink !== 1
        || !same(await loadState(control), state)) {
        throw new Error('Original first activation lock or transaction changed.');
      }
      await publication.checkSources({ signal: null });
      await enabled.checkFiles();
      return state;
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
      await checkAuthority();
      const current = await inspectLinuxServicePolicy(unit, npm);
      if (Object.entries(configuration.state).some(([name, value]) => !runtimeKeys.includes(name)
        && current.state[name] !== (name === 'RefuseManualStart' ? inhibited ? 'yes' : 'no'
          : name === 'Restart' ? inhibited ? 'no' : 'on-failure' : value))
        || !same(current.drops, inhibited ? [inhibition] : [])
        || !same(current.conditions, inhibited ? [['ConditionPathExists', false, true, inhibition]] : [])) {
        throw new Error('Original first-unit activation policy changed.');
      }
      const enablement = await linuxSystemdProperties(unit, ['UnitFileState', 'Job']);
      if (enablement.UnitFileState !== 'enabled' || stopped && enablement.Job !== '0') {
        throw new Error('First-unit enablement or pending job changed.');
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
    }, 'deployment');
    if (signal?.aborted) {
      await activated.stop();
      signal.throwIfAborted();
    }
    return Object.freeze({
      status: activated.status, identity: activated.identity, close,
      async stopActivated() {
        if (closed || busy) throw journalUncertain(new Error('First activation stop requires available live authority.'));
        busy = true;
        try { return await activated.stop(); }
        finally { busy = false; }
      },
    });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw journalUncertain(new AggregateError([error, cleanup])); }
    throw journalUncertain(error);
  }
}
