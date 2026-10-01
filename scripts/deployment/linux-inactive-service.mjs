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
    const checkPolicy = async () => {
      if (await bootId() !== boot
        || !same(await inspectLinuxRuntimeAccount({ unit, project }), runtime)
        || !same(await inspectLinuxServicePolicy(unit, npm), configuration)
        || (await linuxSystemdProperties(unit, ['Job'])).Job !== '') {
        throw new Error('Inactive service account, runtime or policy changed.');
      }
      const object = await linuxSystemdBus(['call', 'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'LoadUnit', 's', unit], 'o');
      if (typeof object !== 'string' || !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(object)) {
        throw new Error('Invalid inactive systemd unit object identity.');
      }
      // Unlike Manager.GetUnitProcesses, the service object can reload a garbage-collected inactive unit.
      const processes = await linuxSystemdBus(['call', 'org.freedesktop.systemd1', object,
        'org.freedesktop.systemd1.Service', 'GetProcesses'], 'a(sus)');
      if (!Array.isArray(processes) || processes.length) {
        throw new Error('Inactive service is not quiescent.');
      }
      if (!same(await Promise.all(executables.map(entry => inspectLinuxServiceExecutable(entry.file))), executables)) {
        throw new Error('Inactive service runtime executables changed.');
      }
    };
    const check = async () => {
      if (closed) throw new Error('Inactive service inspection is closed.');
      signal?.throwIfAborted();
      await sources.check();
      await checkPolicy();
      await checkDomain();
      await checkPolicy();
      await sources.check();
      signal?.throwIfAborted();
    };
    await check();
    const identity = freezeEvidence({ runtime, configuration, executables, bootId: boot,
      controlGroup, sources: sources.identity,
      domain: { present: Boolean(directory), directory: groupInfo ?? null, events: eventsInfo ?? null } });
    return Object.freeze({ kind: 'inactive', identity, check, close });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Inactive service inspection and cleanup failed.');
    }
    throw error;
  }
}
