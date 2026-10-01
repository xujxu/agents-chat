import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import { inspectLinuxRuntimeAccount } from './linux-runtime.mjs';
import { freezeEvidence, inspectLinuxServiceExecutable, inspectLinuxServicePolicy } from './linux-service-inspection.mjs';
import { captureLinuxServiceSources, linuxServiceFileIdentity } from './linux-service-sources.mjs';
import { linuxSystemdBus, linuxSystemdProperties } from './linux-systemd.mjs';

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
const basePath = '/sys/fs/cgroup';
const stateRuntimeKeys = ['MainPID', 'ActiveState', 'SubState', 'ControlGroup', 'InvocationID'];
const accountRuntimeKeys = ['mainPid', 'processIdentity', 'invocationId', 'activeState'];
const outside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};

export async function inspectLinuxInactiveService({ unit, project, npm, node, signal }) {
  let sources;
  let directory;
  let events;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([sources?.close(), directory?.close(), events?.close()]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Could not close inactive service inspection.');
  };
  try {
    signal?.throwIfAborted();
    const runtime = await inspectLinuxRuntimeAccount({ unit, project });
    if (runtime.mainPid !== 0 || !['inactive', 'failed'].includes(runtime.activeState)) {
      throw new Error('Inactive service observation requires a quiescent service.');
    }
    const configuration = await inspectLinuxServicePolicy(unit, npm);
    const state = configuration.state;
    if (state.MainPID !== '0' || state.ActiveState !== runtime.activeState
      || state.InvocationID !== runtime.invocationId
      || state.SubState !== (runtime.activeState === 'inactive' ? 'dead' : 'failed')
      || state.RefuseManualStart !== 'no' || configuration.conditions.length) {
      throw new Error('Inactive service state or uninhibited policy is unsupported or changed.');
    }
    const controlGroup = `/system.slice/${unit}`;
    if (state.ControlGroup && state.ControlGroup !== controlGroup) {
      throw new Error('Inactive service has an unsupported control group.');
    }
    const executables = await Promise.all([npm, node].map(inspectLinuxServiceExecutable));
    if (executables.some(entry => !outside(runtime.project, entry.file) || !outside(runtime.project, entry.target))) {
      throw new Error('Inactive service requires external runtime executables.');
    }
    const boot = await bootId();
    if (!/^[a-f0-9-]{36}$/.test(boot)) throw new Error('Inactive service boot identity is unavailable.');
    sources = await captureLinuxServiceSources([state.FragmentPath, ...configuration.drops]);
    if (await realpath(basePath) !== basePath || (await statfs(basePath)).type !== 0x63677270) {
      throw new Error('Inactive service observation requires canonical cgroup v2.');
    }
    const base = await lstat(basePath);
    const groupPath = `${basePath}${controlGroup}`;
    let groupInfo;
    let eventsInfo;
    try {
      await lstat(groupPath);
      if (!state.ControlGroup) throw new Error('An unreported inactive service domain cannot be adopted.');
      directory = await open(groupPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      events = await open(`${groupPath}/cgroup.events`, constants.O_RDONLY | constants.O_NOFOLLOW);
      groupInfo = linuxServiceFileIdentity(await directory.stat());
      eventsInfo = linuxServiceFileIdentity(await events.stat());
    } catch (error) {
      if (error.code !== 'ENOENT' || directory || events) throw error;
    }
    const checkDomain = async () => {
      const currentBase = await lstat(basePath);
      if (!currentBase.isDirectory() || currentBase.dev !== base.dev || currentBase.ino !== base.ino
        || await realpath(basePath) !== basePath || (await statfs(basePath)).type !== 0x63677270) {
        throw new Error('Inactive service cgroup hierarchy changed.');
      }
      if (!directory) {
        try { await lstat(groupPath); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        throw new Error('Absent inactive service domain was recreated.');
      }
      for (const [file, handle, expected] of [[groupPath, directory, groupInfo],
        [`${groupPath}/cgroup.events`, events, eventsInfo]]) {
        const named = await lstat(file);
        if (named.isSymbolicLink() || named.dev !== base.dev
          || !same(linuxServiceFileIdentity(named), expected)
          || !same(linuxServiceFileIdentity(await handle.stat()), expected)) {
          throw new Error('Inactive service domain changed.');
        }
      }
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await events.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).toString('utf8').match(/^populated ([01])$/m)?.[1] !== '0') {
        throw new Error('Inactive service domain is not verifiably empty.');
      }
    };
    const inhibition = `/etc/systemd/system/${unit}.d/90-agents-chat-deployment.conf`;
    const observePolicy = async ({ original, inhibited, stopped }) => {
      const account = await inspectLinuxRuntimeAccount({ unit, project });
      const current = await inspectLinuxServicePolicy(unit, npm);
      const accountMatches = original ? same(account, runtime) : Object.keys(runtime).every(key =>
        accountRuntimeKeys.includes(key) || same(account[key], runtime[key]));
      const policyMatches = original ? same(current, configuration)
        : Object.keys(state).every(key => stateRuntimeKeys.includes(key) || current.state[key] === (
          inhibited && key === 'RefuseManualStart' ? 'yes' : inhibited && key === 'Restart' ? 'no' : state[key]))
          && same([...current.drops].sort(), [...configuration.drops, ...(inhibited ? [inhibition] : [])].sort())
          && same(current.conditions, inhibited ? [['ConditionPathExists', false, true, inhibition]] : [])
          && same(current.command, configuration.command);
      if (await bootId() !== boot || !accountMatches || !policyMatches) {
        throw new Error('Inactive service account, runtime or inhibition policy changed.');
      }
      if (stopped) {
        if (account.mainPid !== 0 || account.processIdentity !== null
          || !['inactive', 'failed'].includes(account.activeState)
          || account.invocationId && account.invocationId !== runtime.invocationId
          || current.state.MainPID !== '0' || !['inactive', 'failed'].includes(current.state.ActiveState)
          || current.state.SubState !== (current.state.ActiveState === 'inactive' ? 'dead' : 'failed')
          || current.state.InvocationID && current.state.InvocationID !== runtime.invocationId
          || current.state.ControlGroup && current.state.ControlGroup !== controlGroup
          || (await linuxSystemdProperties(unit, ['Job'])).Job !== '') {
          throw new Error('Inactive service is not in its original stopped domain.');
        }
        const object = await linuxSystemdBus(['call', 'org.freedesktop.systemd1',
          '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'LoadUnit', 's', unit], 'o');
        if (typeof object !== 'string' || !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(object)) {
          throw new Error('Invalid inactive systemd unit object identity.');
        }
        // Unlike Manager.GetUnitProcesses, the service object can reload a garbage-collected inactive unit.
        const processes = await linuxSystemdBus(['call', 'org.freedesktop.systemd1', object,
          'org.freedesktop.systemd1.Service', 'GetProcesses'], 'a(sus)');
        if (!Array.isArray(processes) || processes.length) throw new Error('Inactive service is not quiescent.');
      }
      if (!same(await Promise.all(executables.map(entry => inspectLinuxServiceExecutable(entry.file))), executables)) {
        throw new Error('Inactive service runtime executables changed.');
      }
    };
    const checkEvidence = async ({ original = false, inhibited = false, stopped = false }) => {
      if (closed) throw new Error('Inactive service inspection is closed.');
      if (typeof inhibited !== 'boolean' || typeof stopped !== 'boolean') throw new Error('Invalid inactive service policy observation.');
      signal?.throwIfAborted();
      await sources.check();
      await observePolicy({ original, inhibited, stopped });
      if (stopped) await checkDomain();
      await observePolicy({ original, inhibited, stopped });
      await sources.check();
      signal?.throwIfAborted();
    };
    const check = () => checkEvidence({ original: true, stopped: true });
    const checkPolicy = ({ inhibited = false, stopped = false } = {}) => checkEvidence({ inhibited, stopped });
    const checkInhibited = async ({ stopped = true } = {}) => {
      if (stopped !== true) throw new Error('Inactive service inspection only proves an originally stopped domain.');
      await checkEvidence({ inhibited: true, stopped: true });
      return Object.freeze({ stopped: true, inhibited: true });
    };
    await check();
    const identity = freezeEvidence({ runtime, configuration, executables, bootId: boot,
      controlGroup, sources: sources.identity,
      domain: { present: Boolean(directory), directory: groupInfo ?? null, events: eventsInfo ?? null } });
    return Object.freeze({ kind: 'inactive', identity, check, checkPolicy, checkInhibited, close });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Inactive service inspection and cleanup failed.');
    }
    throw error;
  }
}
