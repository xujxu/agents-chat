import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import {
  inspectLinuxServiceExecutable, inspectLinuxServicePolicy, inspectLinuxServiceSource,
} from './linux-service-inspection.mjs';
import { inspectLinuxRuntimeAccount } from './linux-runtime.mjs';
import { checkLinuxInactiveProcesses, linuxInactiveObservationId } from './linux-inactive-service.mjs';
import { linuxServiceFileIdentity } from './linux-service-sources.mjs';
import { processIdentity } from './process-identity.mjs';
import { readWorkerFile } from './worker-files.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileIdentity = info => ({ dev: info.dev, ino: info.ino });
const runtimeKeys = ['MainPID', 'ActiveState', 'SubState', 'ControlGroup', 'InvocationID'];
const accountKeys = ['unit', 'project', 'user', 'uid', 'gid', 'home'];

export async function inspectLinuxColdService({ original: supplied, held = null }) {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Cold service inspection requires Linux root.');
  const original = structuredClone(supplied);
  const { runtime, configuration, executables, sources, bootId, controlGroup } = original ?? {};
  const initiallyStopped = runtime?.mainPid === 0;
  if (!runtime || !configuration?.state || !Array.isArray(executables) || executables.length !== 2
    || !Array.isArray(sources) || !sources.length || sources.length > 33
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,180}\.service$/.test(runtime.unit)
    || controlGroup !== `/system.slice/${runtime.unit}`
    || !initiallyStopped && (!Number.isSafeInteger(runtime.mainPid) || runtime.mainPid <= 0
      || configuration.state.ControlGroup !== controlGroup || configuration.state.ActiveState !== 'active'
      || configuration.state.SubState !== 'running' || configuration.state.MainPID !== String(runtime.mainPid)
      || !/^[a-f0-9]{32}$/.test(runtime.invocationId) || configuration.state.InvocationID !== runtime.invocationId)
    || configuration.state.RefuseManualStart !== 'no' || !same(configuration.conditions, [])) {
    throw new Error('Invalid original cold service identity.');
  }
  const inactiveIdentity = initiallyStopped ? linuxInactiveObservationId(original) : null;
  const domainIdentity = initiallyStopped ? linuxServiceFileIdentity : fileIdentity;
  const inhibition = `/etc/systemd/system/${runtime.unit}.d/90-agents-chat-deployment.conf`;
  if (held !== null && (typeof held !== 'string' || !held.startsWith(`${inhibition}.`)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.held$/.test(held.slice(inhibition.length + 1)))) {
    throw new Error('Invalid held cold service inhibitor.');
  }
  const bytes = Buffer.from(`[Unit]\nRefuseManualStart=yes\nConditionPathExists=!${inhibition}\n[Service]\nRestart=no\n`);
  const retained = [];
  let group;
  let events;
  let groupInfo;
  let eventsInfo;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([...retained.map(entry => entry.handle.close()), group?.close(), events?.close()]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Cold service inspection cleanup failed.');
  };
  try {
    const parent = path.dirname(inhibition);
    const parentInfo = await lstat(parent);
    const checkParent = async () => {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022
        || !same(fileIdentity(info), fileIdentity(parentInfo))) throw new Error('Cold service inhibitor directory changed.');
      if (initiallyStopped) {
        const base = '/sys/fs/cgroup';
        const current = await lstat(base);
        if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== 0 || current.mode & 0o022
          || await realpath(base) !== base || (await statfs(base)).type !== 0x63677270
          || !same(fileIdentity(current), original.domain.base)) {
          throw new Error('Original inactive cgroup hierarchy changed.');
        }
      }
    };
    const checkPolicy = async ({ inhibited = true, stopped = true } = {}) => {
      if (typeof inhibited !== 'boolean' || typeof stopped !== 'boolean') throw new Error('Invalid cold service policy observation.');
      if ((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== bootId) {
        throw new Error('Original service boot identity changed.');
      }
      const current = await inspectLinuxServicePolicy(runtime.unit, executables[0].file);
      const state = current.state;
      if (stopped && (state.MainPID !== '0' || !['inactive', 'failed'].includes(state.ActiveState)
        || state.InvocationID && state.InvocationID !== runtime.invocationId
        || state.ControlGroup && state.ControlGroup !== controlGroup)
        || state.RefuseManualStart !== (inhibited ? 'yes' : configuration.state.RefuseManualStart)
        || state.Restart !== (inhibited ? 'no' : configuration.state.Restart)
        || !same(current.conditions, inhibited ? [['ConditionPathExists', false, true, inhibition]] : [])
        || !same([...current.drops].sort(), [...configuration.drops, ...(inhibited ? [inhibition] : [])].sort())
        || !same(current.command, configuration.command)
        || Object.keys(state).some(key => ![...runtimeKeys, 'RefuseManualStart', 'Restart'].includes(key)
          && state[key] !== configuration.state[key])) {
        throw new Error('Cold service inhibition, generation or original policy changed.');
      }
      const account = await inspectLinuxRuntimeAccount({ unit: runtime.unit, project: runtime.project });
      if (accountKeys.some(key => account[key] !== runtime[key])
        || stopped && (account.mainPid !== 0
          || !initiallyStopped && await processIdentity(runtime.mainPid) === runtime.processIdentity)
        || !same(await Promise.all(executables.map(entry => inspectLinuxServiceExecutable(entry.file))), executables)) {
        throw new Error('Cold service account or executable identity changed.');
      }
      if (initiallyStopped && stopped) await checkLinuxInactiveProcesses(runtime.unit);
    };
    await checkParent();
    await checkPolicy();
    if (!same(sources.map(source => source.path), [configuration.state.FragmentPath, ...configuration.drops])) {
      throw new Error('Cold service source inventory changed.');
    }
    for (const source of sources) {
      const { path: file, sha256, ...expected } = source;
      const actual = await inspectLinuxServiceSource(file);
      if (!same(actual, expected)) throw new Error('Original cold service source changed.');
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      retained.push({ file, handle, expected, sha256, inhibitor: false });
    }
    const handle = await open(inhibition, constants.O_RDONLY | constants.O_NOFOLLOW);
    const inhibitor = { file: inhibition, handle, expected: fileIdentity(await handle.stat()), inhibitor: true };
    retained.push(inhibitor);
    const groupPath = `/sys/fs/cgroup${controlGroup}`;
    try {
      await lstat(groupPath);
      if (initiallyStopped && !original.domain.present) throw new Error('Absent inactive service domain was recreated.');
      if ((await statfs(groupPath)).type !== 0x63677270) throw new Error('Cold service requires cgroup v2.');
      group = await open(groupPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      events = await open(`${groupPath}/cgroup.events`, constants.O_RDONLY | constants.O_NOFOLLOW);
      groupInfo = domainIdentity(await group.stat());
      eventsInfo = domainIdentity(await events.stat());
      if (initiallyStopped && (!same(groupInfo, original.domain.directory) || !same(eventsInfo, original.domain.events))) {
        throw new Error('Original inactive service domain was replaced.');
      }
    } catch (error) {
      // Absence is acceptable only before acquiring either handle; partial observation is not extinction.
      if (error.code !== 'ENOENT' || group || events) throw error;
    }
    const checkFiles = async (includeInhibitor = true) => {
      await checkParent();
      for (const entry of retained) {
        if (entry.inhibitor && !includeInhibitor) continue;
        const info = await entry.handle.stat();
        const named = await lstat(entry.file);
        if (!same(fileIdentity(info), fileIdentity(named)) || !same(fileIdentity(info), fileIdentity(entry.expected))) {
          throw new Error('Retained cold service source or inhibitor replaced.');
        }
        if (entry.inhibitor) {
          if (!info.isFile() || info.uid !== 0 || info.mode & 0o077 || info.nlink !== (held ? 2 : 1)
            || info.size !== bytes.length || named.isSymbolicLink()) throw new Error('Cold service inhibitor changed.');
          const content = Buffer.alloc(bytes.length);
          if ((await entry.handle.read(content, 0, content.length, 0)).bytesRead !== bytes.length
            || !content.equals(bytes)) throw new Error('Cold service inhibitor bytes changed.');
          if (held && !same(fileIdentity(await lstat(held)), fileIdentity(info))) throw new Error('Held inhibitor changed.');
        } else {
          if (!same(await inspectLinuxServiceSource(entry.file), entry.expected)
            || digest(await readWorkerFile(entry.file, 256 * 1024)) !== entry.sha256) {
            throw new Error('Retained cold service source changed.');
          }
        }
      }
    };
    const checkDomain = async () => {
      if (!group) {
        try { await lstat(groupPath); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        throw new Error('Absent cold service domain was recreated.');
      }
      for (const [file, handle, expected] of [[groupPath, group, groupInfo],
        [`${groupPath}/cgroup.events`, events, eventsInfo]]) {
        const named = await lstat(file);
        if (named.isSymbolicLink() || !same(domainIdentity(named), expected)
          || !same(domainIdentity(await handle.stat()), expected)) throw new Error('Cold service domain changed.');
      }
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await events.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).toString('utf8').match(/^populated ([01])$/m)?.[1] !== '0') {
        throw new Error('Cold service domain is not verifiably empty.');
      }
    };
    const check = async () => {
      if (closed) throw new Error('Cold service inspection is closed.');
      await checkFiles();
      await checkPolicy();
      await checkDomain();
      await checkPolicy();
      return Object.freeze({ stopped: true, inhibited: true });
    };
    await check();
    return Object.freeze({
      identity: structuredClone(original), ...(initiallyStopped ? { runtimeIdentity: inactiveIdentity } : {}), check, close,
      async checkInhibited({ stopped = true } = {}) {
        if (stopped !== true) throw new Error('Cold inspection does not authorize an original running generation.');
        return check();
      },
      async checkPolicy({ inhibited = false, stopped = false } = {}) {
        if (closed) throw new Error('Cold service inspection is closed.');
        await checkFiles(false);
        await checkPolicy({ inhibited, stopped });
        if (stopped) await checkDomain();
        await checkFiles(false);
      },
    });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Cold service inspection and cleanup failed.'); }
    throw error;
  }
}
