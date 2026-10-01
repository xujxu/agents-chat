import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import { linuxSystemdBus as bus, linuxSystemdProperties } from './linux-systemd.mjs';
import { inspectLinuxRuntimeAccount } from './linux-runtime.mjs';
import { processIdentity } from './process-identity.mjs';
import { captureLinuxServiceSources, linuxServiceFileIdentity as fileIdentity } from './linux-service-sources.mjs';

export { inspectLinuxServiceSource } from './linux-service-sources.mjs';

const properties = [
  'Id', 'LoadState', 'Transient', 'NeedDaemonReload', 'FragmentPath', 'Type',
  'Slice', 'Delegate', 'KillMode', 'SendSIGKILL', 'ControlGroup', 'InvocationID',
  'MainPID', 'ActiveState', 'SubState', 'RefuseManualStart', 'Restart',
  'User', 'Group', 'DynamicUser', 'SupplementaryGroups', 'WorkingDirectory', 'RootDirectory', 'RootImage',
];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();

export function freezeEvidence(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}

export async function inspectLinuxServicePolicy(unit, npm) {
  const state = await linuxSystemdProperties(unit, properties);
  if (state.Id !== unit || state.LoadState !== 'loaded' || state.Transient !== 'no'
    || state.NeedDaemonReload !== 'no' || !['simple', 'exec'].includes(state.Type)
    || state.Slice !== 'system.slice' || state.Delegate !== 'no'
    || state.KillMode !== 'control-group' || state.SendSIGKILL !== 'yes') {
    throw Object.assign(new Error('Unsupported or stale installed service configuration/stop policy.'), {
      observed: Object.fromEntries([
        'Id', 'LoadState', 'Transient', 'NeedDaemonReload', 'Type', 'Slice', 'Delegate', 'KillMode', 'SendSIGKILL',
      ].map(name => [name, state[name]])),
    });
  }
  // A cleanly stopped unit may be garbage-collected between observations.
  // LoadUnit loads its policy without starting it; typed property lookups also reload it.
  const object = await bus(['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'LoadUnit', 's', unit], 'o');
  if (typeof object !== 'string' || !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(object)) {
    throw new Error('Invalid systemd unit object identity.');
  }
  const [starts, drops, conditions] = await Promise.all([
    bus(['get-property', 'org.freedesktop.systemd1', object,
      'org.freedesktop.systemd1.Service', 'ExecStartEx'], 'a(sasasttttuii)'),
    bus(['get-property', 'org.freedesktop.systemd1', object,
      'org.freedesktop.systemd1.Unit', 'DropInPaths'], 'as'),
    bus(['get-property', 'org.freedesktop.systemd1', object,
      'org.freedesktop.systemd1.Unit', 'Conditions'], 'a(sbbsi)'),
  ]);
  if (!Array.isArray(starts) || starts.length !== 1 || !Array.isArray(starts[0])
    || starts[0].length !== 10 || starts[0][0] !== npm
    || !same(starts[0][1], [npm, 'start']) || !same(starts[0][2], [])) {
    throw new Error('ExecStart command or flags do not match the expected literal npm start.');
  }
  if (!Array.isArray(drops) || drops.length > 32 || drops.some(value => typeof value !== 'string')
    || new Set(drops).size !== drops.length) throw new Error('Unsupported service drop-in inventory.');
  const emptyProperties = await Promise.all([
    ...['ExecStartPreEx', 'ExecStartPostEx', 'ExecStopEx', 'ExecStopPostEx', 'ExecReloadEx'].map(name =>
      bus(['get-property', 'org.freedesktop.systemd1', object,
        'org.freedesktop.systemd1.Service', name], 'a(sasasttttuii)')),
    ...['TriggeredBy', 'OnFailure', 'OnSuccess'].map(name =>
      bus(['get-property', 'org.freedesktop.systemd1', object,
        'org.freedesktop.systemd1.Unit', name], 'as')),
  ]);
  if (emptyProperties.some(value => !Array.isArray(value) || value.length !== 0)) {
    throw new Error('Service hooks or alternate activation policy require explicit support.');
  }
  const forcedRestarts = await bus(['get-property', 'org.freedesktop.systemd1', object,
    'org.freedesktop.systemd1.Service', 'RestartForceExitStatus'], '(aiai)');
  if (!same(forcedRestarts, [[], []])) {
    throw new Error('Forced service restart policy requires explicit support.');
  }
  if (!Array.isArray(conditions) || conditions.some(value => !Array.isArray(value) || value.length !== 5)) {
    throw new Error('Unsupported systemd condition response.');
  }
  return { state, drops, conditions: conditions.map(value => value.slice(0, 4)),
    command: { file: npm, args: ['start'] } };
}

export async function inspectLinuxServiceExecutable(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file
    || /[\0\r\n]/.test(file)) throw new Error('An explicit absolute runtime executable is required.');
  const target = await realpath(file);
  const info = await lstat(target);
  if (!info.isFile() || !(info.mode & 0o111)) throw new Error('Runtime executable is not an executable file.');
  return { file, target, ...fileIdentity(info) };
}

export async function inspectInstalledLinuxService({ unit, project }) {
  const runtime = await inspectLinuxRuntimeAccount({ unit, project });
  if (runtime.mainPid <= 0 || runtime.activeState !== 'active') {
    throw new Error('Installed executable discovery requires a running service.');
  }
  const object = await bus(['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'LoadUnit', 's', unit], 'o');
  if (typeof object !== 'string' || !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(object)) {
    throw new Error('Invalid installed systemd unit object identity.');
  }
  const starts = await bus(['get-property', 'org.freedesktop.systemd1', object,
    'org.freedesktop.systemd1.Service', 'ExecStartEx'], 'a(sasasttttuii)');
  const npm = starts?.[0]?.[0];
  if (!Array.isArray(starts) || starts.length !== 1 || !Array.isArray(starts[0])
    || starts[0].length !== 10 || typeof npm !== 'string' || !path.isAbsolute(npm)
    || !same(starts[0][1], [npm, 'start']) || !same(starts[0][2], [])
    || path.basename(await realpath(npm)) !== 'npm-cli.js') {
    throw new Error('Installed discovery requires a literal npm start command resolving to npm-cli.js.');
  }
  const node = await realpath(`/proc/${runtime.mainPid}/exe`);
  const service = await inspectLinuxService({ unit, project, npm, node });
  if (!same(service.identity.runtime, runtime)) {
    await service.close();
    throw new Error('Installed service generation changed during executable discovery.');
  }
  return service;
}

export async function inspectLinuxService({ unit, project, npm, node }) {
  let sources;
  let directory;
  let events;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([
      sources?.close(), directory?.close(), events?.close(),
    ]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Service inspection handles could not all be closed.');
  };
  try {
    const runtime = await inspectLinuxRuntimeAccount({ unit, project });
    const config = await inspectLinuxServicePolicy(unit, npm);
    if (config.conditions.length || config.state.RefuseManualStart !== 'no') {
      throw new Error('Service already has unsupported start conditions or inhibition.');
    }
    const executables = await Promise.all([inspectLinuxServiceExecutable(npm), inspectLinuxServiceExecutable(node)]);
    const boot = await bootId();
    const { state } = config;
    if (!['/etc/systemd/system/', '/usr/lib/systemd/system/', '/run/systemd/system/']
      .some(root => state.FragmentPath === `${root}${unit}`)) {
      throw new Error('Service fragment is not a canonical installed unit source.');
    }
    const files = [state.FragmentPath, ...config.drops];
    if (new Set(files).size !== files.length) throw new Error('Duplicate service source files.');
    sources = await captureLinuxServiceSources(files);
    const group = `/system.slice/${unit}`;
    if (runtime.mainPid <= 0 || state.MainPID !== String(runtime.mainPid)
      || state.ActiveState !== 'active' || state.SubState !== 'running'
      || state.InvocationID !== runtime.invocationId || state.ControlGroup !== group) {
      throw new Error('Service has no stable running generation/domain identity.');
    }
    const groupPath = `/sys/fs/cgroup${group}`;
    if ((await statfs(groupPath)).type !== 0x63677270) throw new Error('Service domain requires cgroup v2.');
    directory = await open(groupPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    events = await open(`${groupPath}/cgroup.events`, constants.O_RDONLY | constants.O_NOFOLLOW);
    const groupIdentity = fileIdentity(await directory.stat());
    const eventIdentity = fileIdentity(await events.stat());
    const checkSources = sources.check;
    const checkDomain = async () => {
      for (const [file, handle, original] of [[groupPath, directory, groupIdentity],
        [`${groupPath}/cgroup.events`, events, eventIdentity]]) {
        const named = await lstat(file);
        const retained = await handle.stat();
        if (named.isSymbolicLink() || named.dev !== original.dev || named.ino !== original.ino
          || retained.dev !== original.dev || retained.ino !== original.ino) {
          throw new Error('Retained service domain identity was replaced.');
        }
      }
    };
    const population = async (allowDeleted = false) => {
      const buffer = Buffer.alloc(4096);
      let bytesRead;
      try { ({ bytesRead } = await events.read(buffer, 0, buffer.length, 0)); }
      catch (error) {
        if (!allowDeleted || error.code !== 'ENODEV'
          || await readlink(`/proc/self/fd/${directory.fd}`) !== `${groupPath} (deleted)`
          || await bootId() !== boot) throw error;
        return false;
      }
      const value = buffer.subarray(0, bytesRead).toString('utf8').match(/^populated ([01])$/m);
      if (!value) throw new Error('Original service domain population is unavailable.');
      return value[1] === '1';
    };
    const check = async () => {
      if (closed) throw new Error('Service inspection is closed.');
      if (await bootId() !== boot || !same(await inspectLinuxServicePolicy(unit, npm), config)
        || !same(await inspectLinuxRuntimeAccount({ unit, project }), runtime)
        || !same(await Promise.all([inspectLinuxServiceExecutable(npm), inspectLinuxServiceExecutable(node)]), executables)) {
        throw new Error('Service configuration or runtime identity changed.');
      }
      await checkSources();
      await checkDomain();
      if (await realpath(`/proc/${runtime.mainPid}/exe`) !== executables[1].target
        || (await readFile(`/proc/${runtime.mainPid}/cgroup`, 'utf8')).trim() !== `0::${group}`
        || await processIdentity(runtime.mainPid) !== runtime.processIdentity) {
        throw new Error('Service main process executable or cgroup identity does not match.');
      }
      if (!await population()) throw new Error('Running service domain unexpectedly empty.');
      return Object.freeze({ populated: true });
    };
    const inhibition = `/etc/systemd/system/${unit}.d/90-agents-chat-deployment.conf`;
    const checkInhibited = async ({ stopped = false } = {}) => {
      if (closed) throw new Error('Service inspection is closed.');
      const current = await inspectLinuxServicePolicy(unit, npm);
      const ignored = stopped ? ['MainPID', 'ActiveState', 'SubState', 'ControlGroup', 'InvocationID'] : [];
      if (await bootId() !== boot
        || properties.some(key => !ignored.includes(key)
          && current.state[key] !== (key === 'RefuseManualStart' ? 'yes' : key === 'Restart' ? 'no' : state[key]))
        || !same([...current.drops].sort(), [...config.drops, inhibition].sort())
        || !same(current.conditions, [['ConditionPathExists', false, true, inhibition]])) {
        throw new Error('Service inhibition or original configuration changed.');
      }
      await checkSources();
      if (!stopped) {
        if (!same(await inspectLinuxRuntimeAccount({ unit, project }), runtime)
          || await realpath(`/proc/${runtime.mainPid}/exe`) !== executables[1].target
          || (await readFile(`/proc/${runtime.mainPid}/cgroup`, 'utf8')).trim() !== `0::${group}`) {
          throw new Error('Inhibited service runtime identity changed before stop.');
        }
        await checkDomain();
        if (!await population()) throw new Error('Original service domain unexpectedly empty before stop.');
        return { stopped: false };
      }
      if (current.state.InvocationID && current.state.InvocationID !== runtime.invocationId
        || current.state.ControlGroup && current.state.ControlGroup !== group) {
        throw new Error('Stopped service generation/domain was replaced.');
      }
      if (!['inactive', 'failed'].includes(current.state.ActiveState) || current.state.MainPID !== '0') {
        return { stopped: false };
      }
      if (await population(true)) return { stopped: false };
      const after = await linuxSystemdProperties(unit, ['MainPID', 'ActiveState', 'InvocationID', 'ControlGroup']);
      // systemd may clear the retired cgroup/InvocationID after entering a terminal state.
      if (after.MainPID !== '0' || !['inactive', 'failed'].includes(after.ActiveState)
        || after.InvocationID && after.InvocationID !== runtime.invocationId
        || after.ControlGroup && after.ControlGroup !== group) {
        throw new Error('Service identity changed while proving the original domain empty.');
      }
      return { stopped: true };
    };
    const checkPolicy = async ({ inhibited = false, stopped = false } = {}) => {
      if (closed) throw new Error('Service inspection is closed.');
      const current = await inspectLinuxServicePolicy(unit, npm);
      const runtimeKeys = ['MainPID', 'ActiveState', 'SubState', 'ControlGroup', 'InvocationID'];
      if (await bootId() !== boot
        || properties.some(key => !runtimeKeys.includes(key) && current.state[key] !== (
          inhibited && key === 'RefuseManualStart' ? 'yes'
            : inhibited && key === 'Restart' ? 'no' : state[key]))
        || !same([...current.drops].sort(), [...config.drops, ...(inhibited ? [inhibition] : [])].sort())
        || !same(current.conditions, inhibited ? [['ConditionPathExists', false, true, inhibition]] : [])) {
        throw new Error('Original service policy or source configuration changed.');
      }
      await checkSources();
      if (stopped && (current.state.MainPID !== '0' || !['inactive', 'failed'].includes(current.state.ActiveState)
        || current.state.InvocationID && current.state.InvocationID !== runtime.invocationId
        || current.state.ControlGroup && current.state.ControlGroup !== group
        || await population(true))) throw new Error('Original service is not stopped.');
    };
    await check();
    const identity = freezeEvidence({
      runtime, bootId: boot, controlGroup: group, configuration: config, executables,
      sources: sources.identity,
    });
    return Object.freeze({ identity, check, checkInhibited, checkPolicy, close });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Service inspection and handle cleanup failed.'); }
    throw error;
  }
}
