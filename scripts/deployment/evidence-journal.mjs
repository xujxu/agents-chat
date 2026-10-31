import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { externalWorkerDirectory, requirePrivateMode, syncWorkerDirectory } from './worker-files.mjs';

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

export function journalUncertain(cause) {
  return Object.assign(new Error(
    'Worker journal is unavailable or uncertain; retain evidence and inspect before recovery.',
    { cause },
  ), { code: 'DEPLOYMENT_WORKER_UNSETTLED', recoveryAllowed: false });
}

function configuration(options) {
  if (!options || !/^[a-z0-9-]+\.ndjson$/.test(options.name)
    || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1 || options.maximumBytes > 1048576
    || !Number.isSafeInteger(options.maximumRecords) || options.maximumRecords < 1 || options.maximumRecords > 1024
    || typeof options.validate !== 'function') {
    throw new Error('Invalid evidence journal configuration.');
  }
  return Object.freeze({ ...options });
}

async function directory(options) {
  const { root: resolved, info } = await externalWorkerDirectory(options.root, options.project);
  return { root: resolved, info, file: path.join(resolved, options.name) };
}

function regular(info, options) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.size > options.maximumBytes) throw new Error('Invalid worker journal file type, links or size.');
  requirePrivateMode(info);
}

async function namedFile(location, handle, options) {
  const current = await directory(options);
  if (!sameFile(location.info, current.info)) throw new Error('Worker journal directory was replaced.');
  const named = await lstat(location.file);
  const opened = await handle.stat();
  regular(named, options);
  regular(opened, options);
  if (!sameFile(named, opened)) throw new Error('Worker journal file was replaced.');
  return opened;
}

async function contents(location, handle, options) {
  const info = await namedFile(location, handle, options);
  const buffer = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) throw new Error('Worker journal changed during inspection.');
    offset += bytesRead;
  }
  if ((await namedFile(location, handle, options)).size !== info.size) {
    throw new Error('Worker journal changed during inspection.');
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}

function history(content, options) {
  if (!content.endsWith('\n')) throw new Error('Incomplete worker journal; no tail was discarded.');
  const lines = content.slice(0, -1).split('\n');
  if (lines.length > options.maximumRecords) throw new Error('Worker journal exceeds its receipt limit.');
  const receipts = [];
  for (const line of lines) {
    receipts.push(options.validate(JSON.parse(line), receipts));
  }
  return Object.freeze(receipts);
}

export async function readEvidenceJournal(suppliedOptions) {
  let handle;
  let result;
  const errors = [];
  try {
    const options = configuration(suppliedOptions);
    const location = await directory(options);
    regular(await lstat(location.file), options);
    handle = await open(location.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    result = history(await contents(location, handle, options), options);
  } catch (error) { errors.push(error); }
  if (handle) {
    try { await handle.close(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw journalUncertain(errors.length === 1 ? errors[0] : new AggregateError(errors));
  return result;
}

export async function createEvidenceJournal(suppliedOptions) {
  let handle;
  let options;
  let location;
  try {
    options = configuration(suppliedOptions);
    if (await realpath(options.project) !== options.project) {
      throw new Error('Worker journal project must be canonical.');
    }
    location = await directory(options);
    handle = await open(location.file, 'wx+', 0o600);
    await handle.sync();
    await syncWorkerDirectory(location.root);
    await namedFile(location, handle, options);
  } catch (error) {
    if (handle) {
      try { await handle.close(); }
      catch (cleanup) { throw journalUncertain(new AggregateError([error, cleanup])); }
    }
    throw journalUncertain(error);
  }
  let prefix = '';
  const records = [];
  let busy = false;
  let poisoned = false;
  let closing;
  return Object.freeze({
    async check() {
      if (busy || poisoned || closing) throw journalUncertain(new Error('Worker journal writer is not available.'));
      busy = true;
      try {
        if (await contents(location, handle, options) !== prefix) {
          throw new Error('Worker journal prefix changed outside its writer.');
        }
      } catch (error) {
        poisoned = true;
        throw journalUncertain(error);
      } finally { busy = false; }
    },
    async record(value) {
      if (busy || poisoned || closing) throw journalUncertain(new Error('Worker journal writer is not available.'));
      let receipt;
      let line;
      try {
        receipt = options.validate(value, records);
        line = `${JSON.stringify(receipt)}\n`;
        if (records.length >= options.maximumRecords || Buffer.byteLength(prefix + line) > options.maximumBytes) {
          throw new Error('Worker journal exceeds its receipt limit.');
        }
      } catch (error) { throw journalUncertain(error); }
      busy = true;
      try {
        if (await contents(location, handle, options) !== prefix) {
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
        if (await contents(location, handle, options) !== prefix + line) {
          throw new Error('Worker journal changed while appending.');
        }
        prefix += line;
        records.push(receipt);
      } catch (error) {
        poisoned = true;
        throw journalUncertain(error);
      } finally { busy = false; }
    },
    async close() {
      if (busy) throw journalUncertain(new Error('Cannot close an active worker journal append.'));
      closing ??= handle.close().catch(error => { throw journalUncertain(error); });
      await closing;
    },
  });
}
