import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { captureWorkerCommand, workerWire } from '../scripts/deployment/worker-wire.mjs';

async function connection(t) {
  const connected = Promise.withResolvers();
  const server = createServer(socket => connected.resolve(socket));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const client = createConnection({ port: server.address().port, host: '127.0.0.1' });
  client.on('error', () => {});
  const peer = await connected.promise;
  const wire = workerWire(peer);
  t.after(async () => {
    client.destroy();
    wire.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { client, peer, wire };
}

test('command capture freezes copies and preserves literal args and exact environment', () => {
  const original = {
    file: process.execPath, args: ['-e', 'process.exit(0)', '$HOME', '%n'],
    cwd: path.resolve('.'), env: { PATH: 'test', EMPTY: '' },
  };
  const command = captureWorkerCommand(original);
  original.args[0] = 'changed';
  original.env.PATH = 'changed';
  assert.equal(command.args[0], '-e');
  assert.equal(command.env.PATH, 'test');
  assert.equal(Object.isFrozen(command.env), true);
  assert.equal(Object.isFrozen(command.args), true);
});

test('invalid command forms fail rather than enabling an implicit shell or inherited environment', () => {
  const command = { file: process.execPath, args: [], cwd: path.resolve('.'), env: {} };
  for (const mutation of [
    { file: 'node' }, { cwd: 'relative' }, { args: ['bad\0arg'] },
    { args: 'one string' }, { env: null }, { env: { BAD: 1 } },
    { env: { 'BAD=KEY': 'x' } }, { shell: true }, { args: ['x'.repeat(65536)] },
  ]) assert.throws(() => captureWorkerCommand({ ...command, ...mutation }));
});

test('socket frames can be fragmented without losing exact text', async t => {
  const { client, wire } = await connection(t);
  const value = { type: 'ready', message: 'literal-%n-$HOME-\u4e2d' };
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const received = wire.receive();
  for (const byte of bytes) client.write(Buffer.from([byte]));
  assert.deepEqual(await received, value);
});

test('oversized, malformed and invalid UTF-8 frames reject explicitly', async t => {
  for (const bytes of [
    Buffer.from('x'.repeat(131073)), Buffer.from('{oops}\n'),
    Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10]),
  ]) {
    const { client, wire } = await connection(t);
    const received = assert.rejects(wire.receive());
    client.write(bytes);
    await received;
    await assert.rejects(wire.send({ type: 'run' }));
  }
});

test('cancellation and timeout reject pending receives and do not leave a stale waiter', async t => {
  const { client, wire } = await connection(t);
  const controller = new AbortController();
  const reason = new Error('cancel frame');
  const cancelled = assert.rejects(wire.receive({ signal: controller.signal }), error => error === reason);
  controller.abort(reason);
  await cancelled;
  await assert.rejects(wire.receive({ timeoutMs: 10 }), /timed out/);
  const next = wire.receive();
  client.write('{"type":"next"}\n');
  assert.deepEqual(await next, { type: 'next' });
});

test('transport closure and concurrent receives cannot masquerade as valid responses', async t => {
  const { client, wire } = await connection(t);
  const pending = assert.rejects(wire.receive(), /closed/);
  await assert.rejects(wire.receive(), /Concurrent/);
  client.destroy();
  await pending;
  await assert.rejects(wire.receive(), /closed/);
});
