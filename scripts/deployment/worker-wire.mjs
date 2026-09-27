import path from 'node:path';
import { captureWorkerFields } from './worker-identity.mjs';

const text = value => typeof value === 'string' && !value.includes('\0');

export function captureWorkerCommand(value) {
  const fields = captureWorkerFields(value, ['file', 'args', 'cwd', 'env'], 'command');
  if (!text(fields.file) || !path.isAbsolute(fields.file)
    || !text(fields.cwd) || !path.isAbsolute(fields.cwd)
    || !Array.isArray(fields.args) || !fields.args.every(text)
    || !fields.env || typeof fields.env !== 'object' || Array.isArray(fields.env)) {
    throw new Error('Invalid native worker command.');
  }
  const entries = Object.entries(fields.env);
  if (entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !text(value))) {
    throw new Error('Invalid native worker environment.');
  }
  const command = Object.freeze({
    file: fields.file, args: Object.freeze([...fields.args]), cwd: fields.cwd,
    env: Object.freeze(Object.fromEntries(entries)),
  });
  if (Buffer.byteLength(JSON.stringify(command)) > 65536) throw new Error('Native command exceeds limit.');
  return command;
}

export function workerWire(socket) {
  let buffer = Buffer.alloc(0);
  let failure;
  let waiter;
  const queue = [];
  const fail = error => {
    failure ??= error;
    if (waiter) { waiter.reject(failure); waiter = undefined; }
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Native worker transport closed.')));
  socket.on('data', chunk => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 131072) throw new Error('Native worker frame exceeds limit.');
      let end;
      while ((end = buffer.indexOf(10)) !== -1) {
        const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)));
        buffer = buffer.subarray(end + 1);
        if (waiter) { waiter.resolve(frame); waiter = undefined; }
        else {
          if (queue.length >= 4) throw new Error('Unexpected native worker frames.');
          queue.push(frame);
        }
      }
    } catch (error) { fail(error); socket.destroy(); }
  });
  return {
    async receive({ signal, timeoutMs = 30000 } = {}) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (queue.length) return queue.shift();
      if (waiter) throw new Error('Concurrent native worker receive.');
      let timer;
      let cancel;
      try {
        return await new Promise((resolve, reject) => {
          waiter = { resolve, reject };
          cancel = () => { waiter = undefined; reject(signal.reason); };
          signal?.addEventListener('abort', cancel, { once: true });
          timer = setTimeout(() => {
            waiter = undefined;
            reject(new Error('Native worker transport timed out.'));
          }, timeoutMs);
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    },
    async send(frame) {
      if (failure) throw failure;
      const bytes = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(bytes) > 131072) throw new Error('Native worker frame exceeds limit.');
      await new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()));
    },
    close() { socket.destroy(); },
  };
}
