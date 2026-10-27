import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, writeFile, unlink, rename, mkdir, rmdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { fixtureArgs, descriptorArgs } from './deployment-windows-lock-retirement-observation.mjs';

export async function holdLockRetirementSettlement({ source, control, pwsh, previous }) {
  assert.equal(previous.directoryRetired, true);
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
  const { captureWorkerFields } = await load('worker-identity.mjs');
  const identity = await processIdentity(process.pid);
  const transport = windowsControllerTransport({
    pwsh, label: 'Held native lock settlement fixture',
    refused: cause => new Error('Held native lock settlement fixture failed.', { cause }),
    args: [...fixtureArgs({ source, control, identity, previous }),
      '-ObserveRetirement', ...descriptorArgs('Retirement', previous.retirement), '-SettleRetirement', '-Hold'],
  });
  let ready;
  try {
    ready = captureWorkerFields(await transport.wire.receive({ timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held lock settlement');
    assert.equal(ready.type, 'ready');
    assert.equal(ready.pid, transport.child.pid);
    assert.equal(ready.processIdentity, await processIdentity(ready.pid));
    assert.equal(ready.control, control);
    assert.equal(ready.controllerIdentity, identity);
    const prepared = JSON.parse(await readFile(path.join(control, previous.prepared.path)));
    assert.deepEqual(ready.value, {
      status: 'lock-retirement-settled', attemptId: previous.attemptId,
      previousOperationId: prepared.previousOperationId, project: prepared.project,
      prepared: previous.prepared, committed: previous.committed, retirement: previous.retirement,
      terminal: ready.value.terminal, lockIdentity: previous.lockIdentity, lock: previous.owner,
      runtimeAuthority: false, lockAuthority: false,
    });
    assert.equal(ready.value.terminal.path, `inactive-handoff-${previous.attemptId}-lock-retired.json`);
    await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  } catch (cause) { throw await transport.abandon(cause); }
  console.log(`INACTIVE_HISTORY_LOCK_SETTLED_HELD ${JSON.stringify({
    ...previous, terminal: ready.value.terminal,
    directoryRetirementActor: { actorPid: previous.actorPid, actorIdentity: previous.actorIdentity,
      pid: previous.pid, processIdentity: previous.processIdentity },
    actorPid: process.pid, actorIdentity: identity, pid: ready.pid, processIdentity: ready.processIdentity,
  })}`);
  const timer = setInterval(() => {}, 1000);
  try { await new Promise(() => {}); } finally { clearInterval(timer); }
}

export async function assertLockRetirementSettlementAfterDeath({
  source, control, pwsh, admission, previous, state, completionBytes, stage = 'complete',
}) {
  assert.ok(['complete', 'proof', 'publication'].includes(stage));
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const identity = await processIdentity(process.pid);
  assert.equal(previous.directoryRetired, true);
  const actors = [previous.originalActor, previous.retirementActor, previous.ownerRetirementActor,
    previous.directoryRetirementActor, previous];
  assert.equal(new Set(actors.map(actor => actor.actorIdentity)).size, 5);
  for (const actor of actors) {
    assert.notEqual(identity, actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.actorPid), actor.actorIdentity);
    assert.notEqual(await processIdentity(actor.pid), actor.processIdentity);
  }
  const snapshots = [];
  for (const descriptor of [previous.prepared, previous.committed, previous.retirement, previous.terminal]) {
    const file = path.join(control, descriptor.path);
    const bytes = await readFile(file);
    const current = await lstat(file, { bigint: true });
    assert.equal(bytes.length, descriptor.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
    assert.equal(current.dev.toString(), descriptor.dev);
    assert.equal(current.ino.toString(), descriptor.ino);
    snapshots.push({ file, bytes, identity: current });
  }
  const prepared = JSON.parse(snapshots[0].bytes);
  const terminal = JSON.parse(snapshots[3].bytes);
  assert.equal(prepared.oldState, state.toString('utf8'));
  assert.deepEqual(terminal.creator, { pid: previous.actorPid, processIdentity: previous.actorIdentity,
    bridgePid: previous.pid, bridgeIdentity: previous.processIdentity });
  const stateFile = path.join(control, 'state.json');
  const stateIdentity = await lstat(stateFile, { bigint: true });
  assert.equal(stateIdentity.dev.toString(), prepared.state.dev);
  assert.equal(stateIdentity.ino.toString(), prepared.state.ino);
  const completionFile = path.join(control, `retired-${prepared.previousOperationId}-inactive-rollback-history-complete.json`);
  const completionIdentity = await lstat(completionFile, { bigint: true });
  assert.equal(createHash('sha256').update(completionBytes).digest('hex'), previous.completionSha256);
  const args = [...fixtureArgs({ source, control, identity, previous }), '-ObserveRetirement',
    ...descriptorArgs('Retirement', previous.retirement), '-ObserveSettlement',
    ...descriptorArgs('Terminal', previous.terminal)];
  const observe = input => promisify(execFile)(pwsh, input,
    { timeout: 45000, maxBuffer: 2097152, windowsHide: true });
  const expected = {
    status: 'lock-retirement-settled', attemptId: previous.attemptId,
    previousOperationId: prepared.previousOperationId, project: prepared.project,
    prepared: previous.prepared, committed: previous.committed, retirement: previous.retirement,
    terminal: previous.terminal, lockIdentity: previous.lockIdentity, lock: previous.owner,
    runtimeAuthority: false, lockAuthority: false,
  };
  const first = await observe(args);
  assert.equal(first.stderr, '');
  assert.deepEqual(JSON.parse(first.stdout), expected);
  const refused = error => error.message.includes('Lock settlement observation failed; retain evidence.');
  if (stage !== 'publication') {
    const wrong = args.slice();
    wrong[wrong.indexOf('-TerminalIno') + 1] = previous.terminal.ino === '1' ? '2' : '1';
    await assert.rejects(observe(wrong), refused);
    const original = snapshots[3];
    const held = path.join(control, 'fixture-held-lock-terminal.json');
    await rename(original.file, held);
    let replacement;
    try {
      await writeFile(original.file, original.bytes, { flag: 'wx' });
      replacement = await lstat(original.file, { bigint: true });
      assert.notEqual(replacement.ino, original.identity.ino);
      await assert.rejects(observe(args), refused);
      assert.deepEqual(await readFile(original.file), original.bytes);
    } finally {
      if (replacement) {
        const current = await lstat(original.file, { bigint: true });
        assert.equal(current.dev, replacement.dev);
        assert.equal(current.ino, replacement.ino);
        assert.deepEqual(await readFile(original.file), original.bytes);
        await unlink(original.file);
      }
      await rename(held, original.file);
    }
    const directory = path.join(control, 'lock');
    await mkdir(directory);
    const foreign = await lstat(directory, { bigint: true });
    try {
      await assert.rejects(observe(args), refused);
      const current = await lstat(directory, { bigint: true });
      assert.equal(current.dev, foreign.dev);
      assert.equal(current.ino, foreign.ino);
      assert.deepEqual(await readdir(directory), []);
    } finally { await rmdir(directory); }
    const revalidated = await observe(args);
    assert.equal(revalidated.stderr, '');
    assert.deepEqual(JSON.parse(revalidated.stdout), expected);
  }
  const assertSuccessor = successor => {
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const value of [successor.attemptId, successor.newOwner.operationId, successor.newOwner.token]) {
      assert.match(value, guid);
      assert.ok(![prepared.previousOperationId, previous.attemptId,
        prepared.newOwner.operationId, prepared.newOwner.token].includes(value));
    }
    assert.equal(new Set([successor.attemptId, successor.newOwner.operationId, successor.newOwner.token]).size, 3);
    assert.equal(new Date(successor.newOwner.createdAt).toISOString(), successor.newOwner.createdAt);
    assert.ok(successor.newOwner.createdAt >= terminal.settledAt);
    assert.deepEqual(successor, {
      ...prepared, phase: 'stopped-history-handoff-successor-prepared',
      attemptId: successor.attemptId,
      newOwner: {
        version: 1, token: successor.newOwner.token, project: prepared.project,
        operationId: successor.newOwner.operationId, pid: process.pid,
        processIdentity: identity, createdAt: successor.newOwner.createdAt,
      },
      predecessor: {
        attemptId: previous.attemptId, prepared: previous.prepared, committed: previous.committed,
        retirement: previous.retirement, terminal: previous.terminal,
      },
    });
  };
  if (stage !== 'publication') {
    const successorResult = await observe([...args, '-PrepareSuccessor']);
    assert.equal(successorResult.stderr, '');
    assertSuccessor(JSON.parse(successorResult.stdout));
  }
  if (stage !== 'proof') {
    const publicationResult = await observe([...args, '-PrepareSuccessor', '-PublishSuccessor']);
    assert.equal(publicationResult.stderr, '');
    const publication = JSON.parse(publicationResult.stdout);
    assert.deepEqual(Object.keys(publication).sort(), ['observation', 'prepared', 'record']);
    assertSuccessor(publication.record);
    assert.deepEqual(Object.keys(publication.prepared).sort(), ['bytes', 'dev', 'ino', 'path', 'sha256']);
    assert.equal(publication.prepared.path, `inactive-handoff-${publication.record.attemptId}-prepared.json`);
    const publishedFile = path.join(control, publication.prepared.path);
    const publishedBytes = await readFile(publishedFile);
    const publishedIdentity = await lstat(publishedFile, { bigint: true });
    assert.equal(publishedBytes.length, publication.prepared.bytes);
    assert.equal(createHash('sha256').update(publishedBytes).digest('hex'), publication.prepared.sha256);
    assert.equal(publishedIdentity.dev.toString(), publication.prepared.dev);
    assert.equal(publishedIdentity.ino.toString(), publication.prepared.ino);
    assert.deepEqual(JSON.parse(publishedBytes), publication.record);
    assert.deepEqual(publication.observation, {
      status: 'successor-prepared', attemptId: publication.record.attemptId,
      previousAttemptId: previous.attemptId, previousOperationId: prepared.previousOperationId,
      project: prepared.project, prepared: publication.prepared, predecessor: publication.record.predecessor,
      runtimeAuthority: false, lockAuthority: false,
    });
    snapshots.push({ file: publishedFile, bytes: publishedBytes, identity: publishedIdentity });
    await assert.rejects(observe(args), refused);
  }
  const { acquireLock, releaseLock } = await load('state.mjs');
  await assert.rejects(acquireLock(control, { pwsh, admission, project: prepared.project, operationId: randomUUID() }));
  await assert.rejects(releaseLock(control, prepared.newOwner, { pwsh, admission }));
  for (const snapshot of snapshots) {
    assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
    const current = await lstat(snapshot.file, { bigint: true });
    assert.equal(current.dev, snapshot.identity.dev);
    assert.equal(current.ino, snapshot.identity.ino);
  }
  assert.deepEqual((await readdir(control)).filter(name => name.toLowerCase().startsWith('inactive-handoff-')).sort(),
    snapshots.map(snapshot => path.basename(snapshot.file)).sort());
  for (const [file, bytes, originalIdentity] of [
    [stateFile, state, stateIdentity], [completionFile, completionBytes, completionIdentity],
  ]) {
    assert.deepEqual(await readFile(file), bytes);
    const current = await lstat(file, { bigint: true });
    assert.equal(current.dev, originalIdentity.dev);
    assert.equal(current.ino, originalIdentity.ino);
  }
  await assert.rejects(lstat(path.join(control, 'lock')), { code: 'ENOENT' });
  if (stage !== 'publication') {
    console.log('PASS: fresh native successor preparation derives a distinct live owner from settled evidence without publication or authority');
    console.log('PASS: actual lock settlement publisher death preserves exact terminal evidence for a distinct sixth native actor without continuation authority');
  }
  if (stage === 'proof') return;
  console.log('PASS: native successor publication retains every predecessor and creates one exact preparation without continuation authority');
  for (const snapshot of snapshots.reverse()) await unlink(snapshot.file);
}
