import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureWorkerFields, captureOwner, captureDomain } from './worker-identity.mjs';

const maximumBytes = 128 * 1024;
const transitions = {
  intent: ['owned', 'settled', 'blocked'],
  owned: ['admitted', 'settled', 'blocked'],
  admitted: ['settled', 'blocked'],
  settled: ['blocked'],
  blocked: [],
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

function unsafe(cause) {
  return Object.assign(new Error(
    'Worker journal is unavailable or uncertain; retain evidence and inspect before recovery.',
    { cause },
  ), { code: 'DEPLOYMENT_WORKER_UNSETTLED', recoveryAllowed: false });
}

function validateReceipt(value, owner, previous) {
  const fields = captureWorkerFields(value, ['version', 'owner', 'phase', 'domain'], 'receipt');
  const recordedOwner = captureOwner(fields.owner);
  const domain = fields.domain === null ? null : captureDomain(fields.domain, recordedOwner);
  if (fields.version !== 1 || !same(recordedOwner, owner)
    || !Object.hasOwn(transitions, fields.phase)
    || (['owned', 'admitted'].includes(fields.phase) && domain === null)
    || (previous
      ? !transitions[previous.phase].includes(fields.phase)
        || (previous.domain !== null && !same(previous.domain, domain))
      : fields.phase !== 'intent' || domain !== null)) {
    throw new Error('Invalid worker receipt identity or transition.');
  }
  return Object.freeze({ version: 1, owner: recordedOwner, phase: fields.phase, domain });
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function privateMode(info) {
  if (process.platform === 'linux' && (info.uid !== process.getuid() || (info.mode & 0o077))) {
    throw new Error('Worker journal requires private current-user ownership.');
  }
}

async function directory(root, owner) {
  const resolved = path.resolve(root);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolved) !== resolved
    || contains(owner.project, resolved) || contains(resolved, owner.project)) {
    throw new Error('Worker journal requires a canonical external control directory.');
  }
  privateMode(info);
  return { root: resolved, info, file: path.join(resolved, `worker-${owner.workerId}.ndjson`) };
}

function regular(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size > maximumBytes) throw new Error('Invalid worker journal file type, links or size.');
  privateMode(info);
}

async function namedFile(location, handle, owner) {
  const current = await directory(location.root, owner);
  if (!sameFile(location.info, current.info)) throw new Error('Worker journal directory was replaced.');
  const named = await lstat(location.file);
  const opened = await handle.stat();
  regular(named);
  regular(opened);
  if (!sameFile(named, opened)) throw new Error('Worker journal file was replaced.');
  return opened;
}

async function contents(location, handle, owner) {
  const info = await namedFile(location, handle, owner);
  const buffer = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) throw new Error('Worker journal changed during inspection.');
    offset += bytesRead;
  }
  if ((await namedFile(location, handle, owner)).size !== info.size) {
    throw new Error('Worker journal changed during inspection.');
  }
  return buffer.toString('utf8');
}

function history(content, owner) {
  if (!content.endsWith('\n')) throw new Error('Incomplete worker journal; no tail was discarded.');
  const lines = content.slice(0, -1).split('\n');
  if (lines.length > 5) throw new Error('Worker journal exceeds its receipt limit.');
  const receipts = [];
  for (const line of lines) {
    receipts.push(validateReceipt(JSON.parse(line), owner, receipts.at(-1)));
  }
  return Object.freeze(receipts);
}

export async function readWorkerJournal(root, suppliedOwner) {
  let handle;
  let result;
  const errors = [];
  try {
    const owner = captureOwner(suppliedOwner);
    const location = await directory(root, owner);
    regular(await lstat(location.file));
    handle = await open(location.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    result = history(await contents(location, handle, owner), owner);
  } catch (error) { errors.push(error); }
  if (handle) {
    try { await handle.close(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw unsafe(errors.length === 1 ? errors[0] : new AggregateError(errors));
  return result;
}

export async function createWorkerJournal(root, suppliedOwner) {
  let handle;
  let owner;
  let location;
  try {
    owner = captureOwner(suppliedOwner);
    if (await realpath(owner.project) !== owner.project) {
      throw new Error('Worker journal project must be canonical.');
    }
    location = await directory(root, owner);
    handle = await open(location.file, 'wx+', 0o600);
    await handle.sync();
    if (process.platform === 'linux') {
      const parent = await open(location.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await parent.sync(); }
      finally { await parent.close(); }
    }
    await namedFile(location, handle, owner);
  } catch (error) {
    if (handle) {
      try { await handle.close(); }
      catch (cleanup) { throw unsafe(new AggregateError([error, cleanup])); }
    }
    throw unsafe(error);
  }
  let prefix = '';
  let previous;
  let count = 0;
  let busy = false;
  let poisoned = false;
  let closing;
  return Object.freeze({
    async record(value) {
      if (busy || poisoned || closing) throw unsafe(new Error('Worker journal writer is not available.'));
      let receipt;
      let line;
      try {
        receipt = validateReceipt(value, owner, previous);
        line = `${JSON.stringify(receipt)}\n`;
        if (count >= 5 || Buffer.byteLength(prefix + line) > maximumBytes) {
          throw new Error('Worker journal exceeds its receipt limit.');
        }
      } catch (error) { throw unsafe(error); }
      busy = true;
      try {
        if (await contents(location, handle, owner) !== prefix) {
          throw new Error('Worker journal prefix changed outside its writer.');
        }
        const bytes = Buffer.from(line);
        const start = Buffer.byteLength(prefix);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, start + offset);
          if (!bytesWritten) throw new Error('Worker journal append made no progress.');
          offset += bytesWritten;
        }
        await handle.sync();
        if (await contents(location, handle, owner) !== prefix + line) {
          throw new Error('Worker journal changed while appending.');
        }
        prefix += line;
        previous = receipt;
        count++;
      } catch (error) {
        poisoned = true;
        throw unsafe(error);
      } finally { busy = false; }
    },
    async close() {
      if (busy) throw unsafe(new Error('Cannot close an active worker journal append.'));
      closing ??= handle.close().catch(error => { throw unsafe(error); });
      await closing;
    },
  });
}
