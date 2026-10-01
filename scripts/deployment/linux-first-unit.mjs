import { createHash } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { createEvidenceJournal } from './evidence-journal.mjs';
import { assertLockOwner, captureLockOwner, loadState, requireNoServiceMaintenance } from './state.mjs';
import { canonicalWorkerDirectory, readWorkerFile, syncWorkerDirectory } from './worker-files.mjs';
import { readWorkerOperation } from './worker-operation.mjs';
import { retainActivationWorkers } from './service-activation-workers.mjs';
import { inspectLinuxServicePolicy, inspectLinuxServiceSource } from './linux-service-inspection.mjs';
import { linuxNative } from './linux-systemd.mjs';

const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
const directoryIdentity = info => ({ dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const phases = ['intent', 'reserved', 'inhibited', 'created', 'configured'];
const counts = [0, 1, 2, 2, 2];

export async function createLinuxFirstUnit({ installation, control, lock: supplied, signal }) {
  const lock = captureLockOwner(supplied);
  const { project, unit, account, executables, runtime } = installation.identity;
  if (process.platform !== 'linux' || process.getuid() !== 0 || runtime !== 'absent'
    || lock.project !== project || control !== path.join(path.dirname(project), `.${path.basename(project)}.deployment`)) {
    throw new Error('First unit publication requires the fresh project and its privileged deployment owner.');
  }
  const state = await loadState(control);
  if (state?.operationId !== lock.operationId || state.project !== project || state.operation !== 'deploy'
    || state.priorRuntime !== 'absent' || state.phase !== 'configuring' || state.backupId !== null
    || !state.targetCommit || state.errorCode !== null) {
    throw new Error('First unit publication requires matching fresh configuring-phase admission.');
  }
  const root = '/etc/systemd/system';
  const fragment = path.join(root, unit);
  const parent = `${fragment}.d`;
  const inhibition = path.join(parent, '90-agents-chat-deployment.conf');
  const npm = executables[0].file;
  if (npm.includes('$')) throw new Error('First unit publication requires a literal npm executable path without dollar expansion.');
  const nodeDirectory = path.dirname(executables[1].file);
  const inhibitorBytes = Buffer.from(`[Unit]\nRefuseManualStart=yes\nConditionPathExists=!${inhibition}\n[Service]\nRestart=no\n`);
  const unitBytes = Buffer.from([
    '[Unit]', 'Description=Agents Chat', 'After=network.target', '[Service]', 'Type=simple',
    `User=${account.uid}`, `Group=${account.gid}`, `WorkingDirectory=${project.replaceAll('%', '%%')}`,
    'Environment=NODE_ENV=production',
    `Environment=${quote(`PATH=${nodeDirectory}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)}`,
    `Environment=${quote(`HOME=${account.home}`)}`, `ExecStart=${quote(npm)} start`,
    'Restart=on-failure', 'RestartSec=3s', 'Slice=system.slice', 'Delegate=no',
    'KillMode=control-group', 'SendSIGKILL=yes', 'TimeoutStopSec=30s',
    '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\n'));
  if (unitBytes.length > 32768 || inhibitorBytes.length > 32768) throw new Error('First unit source exceeds its publication budget.');
  let journal;
  let workers;
  let parentInfo;
  let closed = false;
  const retained = [];
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([
      ...retained.map(entry => entry.handle.close()), journal?.close(), workers?.close(),
    ]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'First unit authority cleanup failed; retain publication evidence.');
  };
  try {
    const rootInfo = (await canonicalWorkerDirectory(root)).info;
    const checkDirectory = async (directory, expected) => {
      const { info } = await canonicalWorkerDirectory(directory);
      if (info.uid !== 0 || info.mode & 0o022 || !same(directoryIdentity(info), directoryIdentity(expected))) {
        throw new Error('First unit source directory identity or permissions changed.');
      }
    };
    const authority = async () => {
      signal?.throwIfAborted();
      if (closed) throw new Error('First unit authority is closed.');
      await assertLockOwner(control, lock);
      if (!same(await loadState(control), state)) throw new Error('First unit configuring state changed.');
      await installation.checkIdentity();
      await checkDirectory(root, rootInfo);
      if (parentInfo) await checkDirectory(parent, parentInfo);
      await workers?.check();
      await journal?.check();
    };
    await authority();
    await installation.checkUninstalled();
    await requireNoServiceMaintenance(control);
    for (const file of [fragment, parent]) {
      try { await lstat(file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('Existing first unit source requires installed-service inspection, not replacement.');
    }
    const operation = await readWorkerOperation(control);
    if (!same(operation[0].lock, lock) || operation.at(-1).phase !== 'sealed') {
      throw new Error('First unit publication requires matching sealed worker evidence.');
    }
    workers = await retainActivationWorkers(control, lock);
    const base = { version: 1, lock, installation: installation.identity, fragment, inhibition,
      unitSha256: digest(unitBytes), inhibitionSha256: digest(inhibitorBytes) };
    const fileRecords = () => retained.map(entry => ({ file: entry.file, ...entry.info, sha256: digest(entry.bytes) }));
    journal = await createEvidenceJournal({
      root: control, project, name: 'service-install.ndjson', maximumBytes: 256 * 1024, maximumRecords: 5,
      validate(value, records) {
        const { phase, files, ...rest } = value;
        if (!same(rest, base) || phase !== phases[records.length]
          || !same(files, fileRecords().slice(0, counts[records.length]))) {
          throw new Error('Invalid first unit publication receipt.');
        }
        return Object.freeze(value);
      },
    });
    const checkFiles = async () => {
      await authority();
      for (const entry of retained) {
        if (!entry.info || !same(await inspectLinuxServiceSource(entry.file), entry.info)
          || !same(directoryIdentity(await entry.handle.stat()), directoryIdentity(entry.info))
          || !(await readWorkerFile(entry.file, 32768, { privateMode: true })).equals(entry.bytes)) {
          throw new Error('Original first unit source identity or bytes changed.');
        }
      }
    };
    const record = async phase => {
      await checkFiles();
      await journal.record({ ...base, phase, files: fileRecords() });
    };
    const publish = async (file, bytes) => {
      await checkFiles();
      const handle = await open(file, 'wx+', 0o600);
      const entry = { file, bytes, handle };
      retained.push(entry);
      await handle.writeFile(bytes);
      await handle.sync();
      entry.info = await inspectLinuxServiceSource(file);
      await syncWorkerDirectory(path.dirname(file));
      await checkFiles();
      return entry;
    };
    await record('intent');
    await installation.checkUninstalled();
    // An empty exclusive fragment reserves the name without an executable service.
    const reserved = await publish(fragment, Buffer.alloc(0));
    await record('reserved');
    await mkdir(parent, { mode: 0o755 });
    parentInfo = (await canonicalWorkerDirectory(parent)).info;
    await syncWorkerDirectory(root);
    await publish(inhibition, inhibitorBytes);
    await record('inhibited');
    await checkFiles();
    await reserved.handle.writeFile(unitBytes);
    await reserved.handle.sync();
    reserved.bytes = unitBytes;
    reserved.info = await inspectLinuxServiceSource(fragment);
    await syncWorkerDirectory(root);
    await record('created');
    await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
    const configuration = await inspectLinuxServicePolicy(unit, npm);
    const expected = {
      FragmentPath: fragment, Type: 'simple', User: String(account.uid), Group: String(account.gid),
      WorkingDirectory: project, MainPID: '0', ActiveState: 'inactive', SubState: 'dead',
      ControlGroup: '', InvocationID: '', RefuseManualStart: 'yes', Restart: 'no',
    };
    if (Object.entries(expected).some(([key, value]) => configuration.state[key] !== value)
      || !same(configuration.drops, [inhibition])
      || !same(configuration.conditions, [['ConditionPathExists', false, true, inhibition]])) {
      throw new Error('Published first unit has unexpected inactive configuration or startup policy.');
    }
    const check = async () => {
      await checkFiles();
      if (!same(await inspectLinuxServicePolicy(unit, npm), configuration)) {
        throw new Error('Published first unit configuration or runtime changed.');
      }
      await checkFiles();
    };
    await check();
    await record('configured');
    return Object.freeze({
      status: 'configured-inhibited', identity: structuredClone({ project, unit, configuration, files: fileRecords() }),
      check, close,
    });
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'First unit publication failed; retain all evidence.'); }
    throw error;
  }
}
