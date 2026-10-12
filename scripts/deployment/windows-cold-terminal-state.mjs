import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { readWorkerFile } from './worker-files.mjs';
import { captureWorkerFields } from './worker-identity.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

async function captureFile(file, maximum) {
  const before = await lstat(file, { bigint: true });
  const bytes = await readWorkerFile(file, maximum, { privateMode: true });
  const after = await lstat(file, { bigint: true });
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) {
    throw new Error('Cold terminal publication file changed during capture.');
  }
  return { bytes, descriptor: {
    dev: after.dev.toString(), ino: after.ino.toString(), bytes: bytes.length, sha256: digest(bytes),
  } };
}

export async function readWindowsColdTerminalSource(control) {
  const marker = await captureFile(path.join(control, 'cold-restore-terminal.json'), 1048576);
  const record = parse(marker.bytes);
  if (typeof record.oldState !== 'string' || typeof record.nextState !== 'string'
    || Buffer.byteLength(record.oldState) > 65536 || Buffer.byteLength(record.nextState) > 65536) {
    throw new Error('Invalid cold terminal state text.');
  }
  return { ...marker, record, oldBytes: Buffer.from(record.oldState), nextBytes: Buffer.from(record.nextState) };
}

export async function inspectWindowsColdTerminalState(control, source) {
  const marker = await captureFile(path.join(control, 'cold-restore-terminal.json'), 1048576);
  if (!marker.bytes.equals(source.bytes) || !same(marker.descriptor, source.descriptor)) {
    throw new Error('Original cold terminal handoff changed.');
  }
  const names = await readdir(control);
  if (names.some(name => name.startsWith('state.json.lock.pending-')
    || name.startsWith('cold-restore-terminal.json.pending-'))) {
    throw new Error('Incomplete cold terminal publication requires inspection.');
  }
  const state = await captureFile(path.join(control, 'state.json'), 65536);
  const published = state.bytes.equals(source.nextBytes);
  if (!published && (!state.bytes.equals(source.oldBytes) || !same(state.descriptor, source.record.files.state))) {
    throw new Error('Cold terminal state is neither the original inode nor its exact proposed replacement.');
  }
  let stage = null;
  try { await lstat(path.join(control, 'state.json.lock')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; else return { published, state, stage }; }
  stage = await captureFile(path.join(control, 'state.json.lock'), 65536);
  if (published || !stage.bytes.equals(source.nextBytes)) throw new Error('Foreign cold terminal staged state.');
  return { published, state, stage };
}

export async function captureWindowsColdTerminalStateReply(control, source, value, method, before) {
  const reply = captureWorkerFields(value,
    ['status', 'operationId', 'terminalSha256', 'stateSha256'], 'cold terminal state reply');
  const current = await inspectWindowsColdTerminalState(control, source);
  const status = current.published ? 'cold-terminal-state-published' : 'cold-terminal-state-staged';
  if (!same(reply, {
    status, operationId: source.record.operationId, terminalSha256: source.descriptor.sha256,
    stateSha256: digest(source.nextBytes),
  }) || !current.published && !current.stage || method === 'publish-terminal-state' && !current.published
    || method === 'stage-terminal-state' && current.published !== before.published
    || method === 'publish-terminal-state' && !before.published && !before.stage
    || before.published && !current.published
    || before.stage && !same(before.stage.descriptor, (current.published ? current.state : current.stage)?.descriptor)
    || before.published && !same(before.state.descriptor, current.state.descriptor)) {
    throw new Error('Cold terminal state acknowledgement changed or skipped its original publication boundary.');
  }
  return Object.freeze({ ...reply });
}

export async function finishWindowsColdTerminalState(recovery, { signal, onProgress }) {
  let failure;
  try {
    let result = await recovery.stageTerminalState({ signal });
    if (result.status === 'cold-terminal-state-staged') {
      await onProgress?.(Object.freeze({
        step: 'state-staged', operationId: result.operationId, identity: recovery.identity,
      }));
      signal?.throwIfAborted();
      result = await recovery.publishTerminalState({ signal });
    }
    await onProgress?.(Object.freeze({
      step: 'state-published', operationId: result.operationId, identity: recovery.identity,
    }));
    signal?.throwIfAborted();
    return result;
  } catch (error) { failure = error; throw error; }
  finally {
    try { await recovery.close(); }
    catch (error) {
      throw new AggregateError(failure ? [failure, error] : [error], 'Cold terminal publication cleanup failed.');
    }
  }
}
