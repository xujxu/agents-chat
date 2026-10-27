import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, writeFile, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fixtureArgs, descriptorArgs } from './deployment-windows-lock-retirement-observation.mjs';

export async function holdLockDirectoryRetirement({ source, control, pwsh, previous }) {
  assert.equal(previous.ownerRetired, true);
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
  const { captureWorkerFields } = await load('worker-identity.mjs');
  const identity = await processIdentity(process.pid);
  const transport = windowsControllerTransport({
    pwsh, label: 'Held exact directory retirement fixture',
    refused: cause => new Error('Held exact directory retirement fixture failed.', { cause }),
    args: [...fixtureArgs({ source, control, identity, previous }),
      '-ObserveRetirement', ...descriptorArgs('Retirement', previous.retirement), '-RetireDirectory', '-Hold'],
  });
  let ready;
  try {
    ready = captureWorkerFields(await transport.wire.receive({ timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held directory retirement');
    assert.equal(ready.type, 'ready');
    assert.equal(ready.pid, transport.child.pid);
    assert.equal(ready.processIdentity, await processIdentity(ready.pid));
    assert.equal(ready.control, control);
    assert.equal(ready.controllerIdentity, identity);
    const prepared = JSON.parse(await readFile(path.join(control, previous.prepared.path)));
    assert.deepEqual(ready.value, {
      status: 'lock-retirement-directory-retired', attemptId: previous.attemptId,
      previousOperationId: prepared.previousOperationId, project: prepared.project,
      prepared: previous.prepared, committed: previous.committed, retirement: previous.retirement,
      lockIdentity: previous.lockIdentity, lock: previous.owner, runtimeAuthority: false, lockAuthority: false,
    });
    await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  } catch (cause) { throw await transport.abandon(cause); }
  console.log(`INACTIVE_HISTORY_DIRECTORY_RETIRED_HELD ${JSON.stringify({
    ...previous, directoryRetired: true,
    ownerRetirementActor: { actorPid: previous.actorPid, actorIdentity: previous.actorIdentity,
      pid: previous.pid, processIdentity: previous.processIdentity },
    actorPid: process.pid, actorIdentity: identity, pid: ready.pid, processIdentity: ready.processIdentity,
  })}`);
  const timer = setInterval(() => {}, 1000);
  try { await new Promise(() => {}); } finally { clearInterval(timer); }
}

export async function assertLockDirectoryRetirementAfterDeath({
  source, control, pwsh, admission, previous, state, completionBytes,
}) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const identity = await processIdentity(process.pid);
  assert.equal(previous.ownerRetired, true);
  assert.equal(previous.directoryRetired, true);
  const actors = [previous.originalActor, previous.retirementActor, previous.ownerRetirementActor, previous];
  assert.equal(new Set(actors.map(actor => actor.actorIdentity)).size, 4);
  for (const actor of actors) {
    assert.notEqual(identity, actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.actorPid), actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.pid), actor.processIdentity);
  }
  const snapshots = [];
  for (const descriptor of [previous.prepared, previous.committed, previous.retirement]) {
    const file = path.join(control, descriptor.path);
    const bytes = await readFile(file);
    const current = await lstat(file, { bigint: true });
    assert.equal(bytes.length, descriptor.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
    assert.equal(current.dev.toString(), descriptor.dev);
    assert.equal(current.ino.toString(), descriptor.ino);
    snapshots.push({ file, bytes, identity: current });
  }
  const [prepared, committed, intent] = snapshots.map(snapshot => JSON.parse(snapshot.bytes));
  assert.equal(prepared.oldState, state.toString('utf8'));
  assert.equal(prepared.newOwner.pid, actors[0].actorPid);
  assert.equal(prepared.newOwner.processIdentity, actors[0].actorIdentity);
  assert.deepEqual(committed.newOwner, prepared.newOwner);
  assert.deepEqual(committed.lock, previous.owner);
  assert.deepEqual(committed.lockIdentity, previous.lockIdentity);
  assert.deepEqual(committed.creator, { pid: actors[0].actorPid, processIdentity: actors[0].actorIdentity,
    bridgePid: actors[0].pid, bridgeIdentity: actors[0].processIdentity });
  assert.deepEqual(intent.creator, { pid: actors[1].actorPid, processIdentity: actors[1].actorIdentity,
    bridgePid: actors[1].pid, bridgeIdentity: actors[1].processIdentity });
  const stateFile = path.join(control, 'state.json');
  const stateIdentity = await lstat(stateFile, { bigint: true });
  assert.equal(stateIdentity.dev.toString(), prepared.state.dev);
  assert.equal(stateIdentity.ino.toString(), prepared.state.ino);
  assert.equal(createHash('sha256').update(state).digest('hex'), prepared.state.sha256);
  const completionFile = path.join(control, `retired-${prepared.previousOperationId}-inactive-rollback-history-complete.json`);
  const completionIdentity = await lstat(completionFile, { bigint: true });
  assert.equal(createHash('sha256').update(completionBytes).digest('hex'), previous.completionSha256);
  const args = [...fixtureArgs({ source, control, identity, previous }), '-ObserveRetirement',
    ...descriptorArgs('Retirement', previous.retirement)];
  const invoke = extra => promisify(execFile)(pwsh, [...args, ...extra],
    { timeout: 45000, maxBuffer: 131072, windowsHide: true });
  const expected = {
    status: 'lock-retirement-directory-retired', attemptId: previous.attemptId,
    previousOperationId: prepared.previousOperationId, project: prepared.project,
    prepared: previous.prepared, committed: previous.committed, retirement: previous.retirement,
    lockIdentity: previous.lockIdentity, lock: previous.owner, runtimeAuthority: false, lockAuthority: false,
  };
  for (const extra of [[], ['-RetireDirectory']]) {
    const result = await invoke(extra);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
    await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  }
  const wrongArgs = args.slice();
  wrongArgs[wrongArgs.indexOf('-RetirementIno') + 1] = previous.retirement.ino === '1' ? '2' : '1';
  await assert.rejects(promisify(execFile)(pwsh, wrongArgs,
    { timeout: 45000, maxBuffer: 131072, windowsHide: true }),
  error => error.message.includes('Lock retirement observation failed; retain evidence.'));
  const changed = Buffer.concat([state, Buffer.from('\n')]);
  await writeFile(stateFile, changed);
  try {
    await assert.rejects(invoke([]),
      error => error.message.includes('Lock retirement observation failed; retain evidence.'));
    assert.deepEqual(await readFile(stateFile), changed);
  } finally { await writeFile(stateFile, state); }
  const revalidated = await invoke([]);
  assert.equal(revalidated.stderr, '');
  assert.deepEqual(JSON.parse(revalidated.stdout), expected);
  const { acquireLock, releaseLock } = await load('state.mjs');
  await assert.rejects(acquireLock(control, { pwsh, admission, project: prepared.project, operationId: randomUUID() }));
  await assert.rejects(releaseLock(control, prepared.newOwner, { pwsh, admission }));
  const settledResult = await invoke(['-SettleRetirement']);
  assert.equal(settledResult.stderr, '');
  const settled = JSON.parse(settledResult.stdout);
  const terminal = settled.terminal;
  assert.deepEqual(settled, { ...expected, status: 'lock-retirement-settled', terminal });
  assert.deepEqual(Object.keys(terminal).sort(), ['path', 'dev', 'ino', 'bytes', 'sha256'].sort());
  assert.equal(terminal.path, `inactive-handoff-${previous.attemptId}-lock-retired.json`);
  const terminalFile = path.join(control, terminal.path);
  const terminalBytes = await readFile(terminalFile);
  const terminalIdentity = await lstat(terminalFile, { bigint: true });
  assert.equal(terminalBytes.length, terminal.bytes);
  assert.equal(createHash('sha256').update(terminalBytes).digest('hex'), terminal.sha256);
  assert.equal(terminalIdentity.dev.toString(), terminal.dev);
  assert.equal(terminalIdentity.ino.toString(), terminal.ino);
  const record = JSON.parse(terminalBytes);
  assert.deepEqual(Object.keys(record).sort(), [
    'version', 'phase', 'attemptId', 'control', 'project', 'controlIdentity', 'previousOperationId',
    'prepared', 'committed', 'retirement', 'newOwner', 'lockIdentity', 'lock', 'creator', 'settledAt',
  ].sort());
  assert.equal(record.version, 1);
  assert.equal(record.phase, 'stopped-history-handoff-lock-retired');
  assert.equal(record.attemptId, previous.attemptId);
  assert.equal(record.control, control);
  assert.equal(record.project, prepared.project);
  assert.deepEqual(record.controlIdentity, prepared.controlIdentity);
  assert.equal(record.previousOperationId, prepared.previousOperationId);
  assert.deepEqual(record.prepared, previous.prepared);
  assert.deepEqual(record.committed, previous.committed);
  assert.deepEqual(record.retirement, previous.retirement);
  assert.deepEqual(record.newOwner, prepared.newOwner);
  assert.deepEqual(record.lockIdentity, previous.lockIdentity);
  assert.deepEqual(record.lock, previous.owner);
  assert.equal(record.creator.pid, process.pid);
  assert.equal(record.creator.processIdentity, identity);
  assert.notEqual(await processIdentity(record.creator.bridgePid), record.creator.bridgeIdentity);
  assert.match(record.settledAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(record.settledAt) >= Date.parse(intent.createdAt));
  for (const extra of [[], ['-SettleRetirement']]) {
    await assert.rejects(invoke(extra),
      error => error.message.includes('Lock retirement observation failed; retain evidence.'));
  }
  await assert.rejects(invoke(['-ObserveSettlement', ...descriptorArgs('Terminal', terminal)]),
    error => error.message.includes('Lock settlement observation failed; retain evidence.'));
  snapshots.push({ file: terminalFile, bytes: terminalBytes, identity: terminalIdentity });
  await assert.rejects(acquireLock(control, { pwsh, admission, project: prepared.project, operationId: randomUUID() }));
  await assert.rejects(releaseLock(control, prepared.newOwner, { pwsh, admission }));
  for (const snapshot of snapshots) {
    assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
    const current = await lstat(snapshot.file, { bigint: true });
    assert.equal(current.dev, snapshot.identity.dev);
    assert.equal(current.ino, snapshot.identity.ino);
  }
  assert.deepEqual((await readdir(control)).filter(name => name.toLowerCase().startsWith('inactive-handoff-')).sort(),
    [previous.prepared.path, previous.committed.path, previous.retirement.path, terminal.path].sort());
  for (const [file, bytes, original] of [
    [stateFile, state, stateIdentity], [completionFile, completionBytes, completionIdentity],
  ]) {
    assert.deepEqual(await readFile(file), bytes);
    const current = await lstat(file, { bigint: true });
    assert.equal(current.dev, original.dev);
    assert.equal(current.ino, original.ino);
  }
  await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  for (const snapshot of snapshots.reverse()) await unlink(snapshot.file);
  console.log('PASS: native lock retirement settlement seals one exact terminal without changing evidence or granting continuation');
  console.log('PASS: actual directory retirement executor death leaves exact immutable evidence for a distinct fifth native actor without authority');
}
