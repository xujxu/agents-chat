import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { linuxNative, linuxSystemdProperties } from './linux-systemd.mjs';
import { captureLinuxAccount } from './worker-identity.mjs';
import { canonicalWorkerDirectory } from './worker-files.mjs';
import { processIdentity } from './process-identity.mjs';

const names = [
  'LoadState', 'User', 'Group', 'DynamicUser', 'SupplementaryGroups', 'WorkingDirectory',
  'RootDirectory', 'RootImage', 'MainPID', 'InvocationID', 'ActiveState',
];
const accountKey = value => typeof value === 'string' && /^(?:[0-9]+|[a-zA-Z_][a-zA-Z0-9_.-]{0,63}\$?)$/.test(value);
const id = value => {
  if (!/^[0-9]+$/.test(value)) throw new Error('Invalid NSS numeric account identity.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > 2147483647) throw new Error('Unsupported NSS account identity.');
  return number;
};

export async function inspectLinuxRuntimeAccount({ unit, project }) {
  if (process.platform !== 'linux' || process.getuid() !== 0) {
    throw new Error('Linux runtime inspection requires the privileged system manager controller.');
  }
  const { root } = await canonicalWorkerDirectory(project);
  const initial = await linuxSystemdProperties(unit, names);
  if (initial.LoadState !== 'loaded') throw new Error('Existing systemd service is not loaded.');
  if (initial.DynamicUser !== 'no') throw new Error('Dynamic systemd user identities are unsupported.');
  if (initial.SupplementaryGroups) throw new Error('Explicit supplementary service groups require a supported group policy.');
  if (initial.RootDirectory || initial.RootImage) throw new Error('Isolated service root directories are unsupported.');
  if (!path.isAbsolute(initial.WorkingDirectory)
    || (await canonicalWorkerDirectory(initial.WorkingDirectory)).root !== root) {
    throw new Error('Systemd service working directory does not match this project.');
  }
  const userKey = initial.User || '0';
  if (!accountKey(userKey) || initial.Group && !accountKey(initial.Group)) throw new Error('Unsupported systemd account name.');
  const { stdout: passwd } = await linuxNative('/usr/bin/getent', ['passwd', userKey]);
  const user = passwd.trimEnd().split(':');
  if (user.length !== 7 || !accountKey(user[0]) || !path.isAbsolute(user[5])
    || /[\0\r\n]/.test(user.join('')) || user[5].length > 4096) throw new Error('Invalid NSS user record.');
  const uid = id(user[2]);
  if (/^[0-9]+$/.test(userKey) ? uid !== id(userKey) : user[0] !== userKey) {
    throw new Error('NSS user identity changed.');
  }
  let gid = id(user[3]);
  if (initial.Group) {
    const { stdout } = await linuxNative('/usr/bin/getent', ['group', initial.Group]);
    const group = stdout.trimEnd().split(':');
    if (group.length !== 4 || !accountKey(group[0]) || /[\0\r\n]/.test(group.join(''))) throw new Error('Invalid NSS group record.');
    gid = id(group[2]);
    if (/^[0-9]+$/.test(initial.Group) ? gid !== id(initial.Group) : group[0] !== initial.Group) {
      throw new Error('NSS group identity changed.');
    }
  }
  const { stdout: groups } = await linuxNative('/usr/bin/id', ['-G', '--', user[0]]);
  if (groups.trim().split(/\s+/).map(id).some(group => group !== gid)) {
    throw new Error('Supplementary NSS groups require an explicit supported runtime group policy.');
  }
  const account = captureLinuxAccount({ uid, gid });
  const mainPid = id(initial.MainPID);
  let controllerIdentity = null;
  if (mainPid) {
    controllerIdentity = await processIdentity(mainPid);
    if (!controllerIdentity || !/^[a-f0-9]{32}$/.test(initial.InvocationID)) throw new Error('Running service identity is unavailable.');
    const status = await readFile(`/proc/${mainPid}/status`, 'utf8');
    for (const [label, expected] of [['Uid', uid], ['Gid', gid]]) {
      const values = status.match(new RegExp(`^${label}:\\s+([0-9 \\t]+)$`, 'm'))?.[1].trim().split(/\s+/);
      if (!values || values.length !== 4 || values.map(id).some(value => value !== expected)) {
        throw new Error('Running service account does not match configured identity.');
      }
    }
    const actualGroups = status.match(/^Groups:[ \t]*([0-9 \t]*)$/m)?.[1];
    if (actualGroups === undefined || actualGroups.trim() && actualGroups.trim().split(/\s+/).map(id).some(value => value !== gid)) {
      throw new Error('Running service has unsupported supplementary groups.');
    }
  } else if (!['inactive', 'failed'].includes(initial.ActiveState)) {
    throw new Error('Service has no stable main process identity.');
  }
  const after = await linuxSystemdProperties(unit, names);
  if (Object.keys(initial).some(key => initial[key] !== after[key])
    || mainPid && await processIdentity(mainPid) !== controllerIdentity) {
    throw new Error('Service identity changed during account inspection.');
  }
  return Object.freeze({
    unit, project: root, user: user[0], ...account, home: user[5],
    mainPid, processIdentity: controllerIdentity, invocationId: initial.InvocationID,
    activeState: initial.ActiveState,
  });
}
