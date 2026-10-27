import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function publishSuccessorAbandonment({
  source, control, pwsh, identity, args, expected, original, successor, previous, hold = false,
}) {
  const load = name => import(pathToFileURL(path.join(source, name)).href);
  const { processIdentity } = await load('process-identity.mjs');
  const { windowsControllerTransport } = await load('windows-controller-transport.mjs');
  const { captureWorkerFields } = await load('worker-identity.mjs');
  const transport = windowsControllerTransport({
    pwsh, args: [...args, '-SealSuccessor', ...(hold ? ['-Hold'] : [])], label: 'Native successor abandonment fixture',
    refused: cause => new Error('Native successor abandonment fixture failed.', { cause }),
  });
  let diagnostic = '';
  transport.child.stderr.on('data', bytes => { diagnostic = `${diagnostic}${bytes.toString('utf8')}`.slice(-4096); });
  try {
    const ready = captureWorkerFields(await transport.wire.receive({ timeoutMs: 45000 }),
      ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'successor observed');
    assert.equal(ready.type, 'successor-observed');
    assert.equal(ready.pid, transport.child.pid);
    assert.equal(ready.processIdentity, await processIdentity(ready.pid));
    assert.equal(ready.control, control);
    assert.equal(ready.controllerIdentity, identity);
    assert.deepEqual(ready.value, expected);
    await transport.wire.send({ type: 'seal' });
    let response = await transport.wire.receive({ timeoutMs: 45000 });
    if (hold) {
      const held = captureWorkerFields(response,
        ['type', 'pid', 'processIdentity', 'control', 'controllerIdentity', 'value'], 'held successor abandoned');
      assert.equal(held.type, 'ready');
      assert.equal(held.pid, ready.pid);
      assert.equal(held.processIdentity, ready.processIdentity);
      assert.equal(held.processIdentity, await processIdentity(held.pid));
      assert.equal(held.control, control);
      assert.equal(held.controllerIdentity, identity);
      response = held.value;
    } else {
      assert.deepEqual(await transport.waitForExit(), { code: 0, signal: null });
      transport.wire.close();
    }
    const result = captureWorkerFields(response, ['abandoned', 'record'], 'successor abandoned');
    assert.equal(diagnostic, '');
    const descriptor = result.abandoned;
    assert.deepEqual(Object.keys(descriptor).sort(), ['bytes', 'dev', 'ino', 'path', 'sha256']);
    assert.equal(descriptor.path, `inactive-handoff-${previous.successorAttemptId}-abandoned.json`);
    const file = path.join(control, descriptor.path);
    const bytes = await readFile(file);
    const current = await lstat(file, { bigint: true });
    assert.equal(bytes.length, descriptor.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
    assert.equal(current.dev.toString(), descriptor.dev);
    assert.equal(current.ino.toString(), descriptor.ino);
    assert.deepEqual(JSON.parse(bytes), result.record);
    assert.deepEqual(result.record, {
      version: 1, phase: 'stopped-history-handoff-successor-abandoned',
      attemptId: previous.successorAttemptId, control, project: original.project,
      controlIdentity: original.controlIdentity, previousOperationId: original.previousOperationId,
      prepared: previous.successor,
      creator: {
        pid: process.pid, processIdentity: identity,
        bridgePid: ready.pid, bridgeIdentity: ready.processIdentity,
      },
      settledAt: result.record.settledAt,
    });
    assert.equal(new Date(result.record.settledAt).toISOString(), result.record.settledAt);
    assert.ok(result.record.settledAt >= successor.newOwner.createdAt);
    const snapshot = { file, bytes, identity: current };
    if (hold) return { transport, snapshot, descriptor, record: result.record, bridge: ready };
    return snapshot;
  } catch (cause) {
    const error = await transport.abandon(cause);
    if (error.diagnostic) console.error(error.diagnostic);
    throw error;
  }
}
