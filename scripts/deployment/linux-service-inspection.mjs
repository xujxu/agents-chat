import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import { linuxNative, linuxSystemdProperties } from './linux-systemd.mjs';
import { inspectLinuxRuntimeAccount } from './linux-runtime.mjs';
import { processIdentity } from './process-identity.mjs';

const properties = [
  'Id', 'LoadState', 'Transient', 'NeedDaemonReload', 'FragmentPath', 'Type',
  'Slice', 'Delegate', 'KillMode', 'SendSIGKILL', 'ControlGroup', 'InvocationID',
  'MainPID', 'ActiveState', 'SubState',
];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fileIdentity = info => ({
  dev: info.dev, ino: info.ino, size: info.size, mode: info.mode,
  uid: info.uid, gid: info.gid, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();

async function bus(args, signature) {
  const { stdout } = await linuxNative('/usr/bin/busctl', ['--system', '--json=short', ...args]);
  const result = JSON.parse(stdout);
  if (result.type !== signature || !Array.isArray(result.data)
    || args[0] === 'call' && result.data.length !== 1) {
    throw new Error('Unsupported typed systemd property response.');
  }
  // Method replies wrap their return arguments; get-property unwraps its variant.
  return args[0] === 'call' ? result.data[0] : result.data;
}

async function configuration(unit, npm) {
  const state = await linuxSystemdProperties(unit, properties);
  if (state.Id !== unit || state.LoadState !== 'loaded' || state.Transient !== 'no'
    || state.NeedDaemonReload !== 'no' || !['simple', 'exec'].includes(state.Type)
    || state.Slice !== 'system.slice' || state.Delegate !== 'no'
    || state.KillMode !== 'control-group' || state.SendSIGKILL !== 'yes') {
    throw new Error('Unsupported or stale installed service configuration/stop policy.');
  }
  const object = await bus(['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'GetUnit', 's', unit], 'o');
  if (typeof object !== 'string' || !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(object)) {
    throw new Error('Invalid systemd unit object identity.');
  }
  const [starts, drops] = await Promise.all([
    bus(['get-property', 'org.freedesktop.systemd1', object,
      'org.freedesktop.systemd1.Service', 'ExecStartEx'], 'a(sasasttttuii)'),
    bus(['get-property', 'org.freedesktop.systemd1', object,
      'org.freedesktop.systemd1.Unit', 'DropInPaths'], 'as'),
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
  return { state, drops, command: { file: npm, args: ['start'] } };
}

async function sourceDirectory(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022) {
      throw new Error('Service source directory is writable, linked or not root-owned.');
    }
    if (current === '/') break;
  }
}

async function sourceInfo(file) {
  await sourceDirectory(path.dirname(file));
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022
    || info.nlink !== 1 || info.size > 256 * 1024) {
    throw new Error('Service source file has unsupported type, permissions or size.');
  }
  return fileIdentity(info);
}

async function executable(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file
    || /[\0\r\n]/.test(file)) throw new Error('An explicit absolute runtime executable is required.');
  const target = await realpath(file);
  const info = await lstat(target);
  if (!info.isFile() || !(info.mode & 0o111)) throw new Error('Runtime executable is not an executable file.');
  return { file, target, ...fileIdentity(info) };
}

export async function inspectLinuxService({ unit, project, npm, node }) {
  const sources = [];
  let directory;
  let events;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([
      ...sources.map(source => source.handle.close()), directory?.close(), events?.close(),
    ]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Service inspection handles could not all be closed.');
  };
  try {
    const runtime = await inspectLinuxRuntimeAccount({ unit, project });
    const config = await configuration(unit, npm);
    const executables = await Promise.all([executable(npm), executable(node)]);
    const boot = await bootId();
    const { state } = config;
    if (!['/etc/systemd/system/', '/usr/lib/systemd/system/', '/run/systemd/system/']
      .some(root => state.FragmentPath === `${root}${unit}`)) {
      throw new Error('Service fragment is not a canonical installed unit source.');
    }
    const files = [state.FragmentPath, ...config.drops];
    if (new Set(files).size !== files.length) throw new Error('Duplicate service source files.');
    for (const file of files) {
      if (!path.isAbsolute(file) || path.resolve(file) !== file || /[\0\r\n]/.test(file)) {
        throw new Error('Noncanonical service source path.');
      }
      const original = await sourceInfo(file);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const source = { file, handle, original };
      sources.push(source);
      const bytes = Buffer.alloc(original.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length || !same(fileIdentity(await handle.stat()), original)
        || !same(await sourceInfo(file), original)) throw new Error('Service source file changed while reading.');
      source.sha256 = hash(bytes);
    }
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
    const check = async () => {
      if (closed) throw new Error('Service inspection is closed.');
      if (await bootId() !== boot || !same(await configuration(unit, npm), config)
        || !same(await inspectLinuxRuntimeAccount({ unit, project }), runtime)
        || !same(await Promise.all([executable(npm), executable(node)]), executables)) {
        throw new Error('Service configuration or runtime identity changed.');
      }
      for (const source of sources) {
        const bytes = Buffer.alloc(source.original.size);
        const { bytesRead } = await source.handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length || hash(bytes) !== source.sha256
          || !same(fileIdentity(await source.handle.stat()), source.original)
          || !same(await sourceInfo(source.file), source.original)) {
          throw new Error('Retained service source file was changed or replaced.');
        }
      }
      for (const [file, handle, original] of [[groupPath, directory, groupIdentity],
        [`${groupPath}/cgroup.events`, events, eventIdentity]]) {
        const named = await lstat(file);
        const retained = await handle.stat();
        if (named.isSymbolicLink() || named.dev !== original.dev || named.ino !== original.ino
          || retained.dev !== original.dev || retained.ino !== original.ino) {
          throw new Error('Retained service domain identity was replaced.');
        }
      }
      if (await realpath(`/proc/${runtime.mainPid}/exe`) !== executables[1].target
        || (await readFile(`/proc/${runtime.mainPid}/cgroup`, 'utf8')).trim() !== `0::${group}`
        || await processIdentity(runtime.mainPid) !== runtime.processIdentity) {
        throw new Error('Service main process executable or cgroup identity does not match.');
      }
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await events.read(buffer, 0, buffer.length, 0);
      const population = buffer.subarray(0, bytesRead).toString('utf8').match(/^populated ([01])$/m);
      if (!population || population[1] !== '1') throw new Error('Running service domain population is unavailable.');
      return Object.freeze({ populated: true });
    };
    await check();
    const identity = Object.freeze({
      runtime, bootId: boot, controlGroup: group,
      sources: Object.freeze(sources.map(source => Object.freeze({
        path: source.file, ...source.original, sha256: source.sha256,
      }))),
    });
    return Object.freeze({ identity, check, close });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Service inspection and handle cleanup failed.'); }
    throw error;
  }
}
