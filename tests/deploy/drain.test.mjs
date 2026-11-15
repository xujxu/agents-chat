import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { waitForIdle } from '../../scripts/deploy/fsops.mjs';

async function healthServer(respond) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(respond()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('waits for running replies to finish before returning', async () => {
  let polls = 0;
  const server = await healthServer(() => ({ ok: true, activeReplies: ++polls < 3 ? 1 : 0 }));
  try {
    assert.equal(await waitForIdle(server.port, 10, { pollMs: 10 }), 0);
    assert.equal(polls, 3);
  } finally {
    await server.close();
  }
});

test('gives up after the drain timeout and reports the replies it will interrupt', async () => {
  const server = await healthServer(() => ({ ok: true, activeReplies: 2 }));
  try {
    const started = Date.now();
    assert.equal(await waitForIdle(server.port, 1, { pollMs: 50 }), 2);
    assert.ok(Date.now() - started < 5000);
  } finally {
    await server.close();
  }
});

test('does not wait for a stopped server or an older release without the field', async () => {
  const server = await healthServer(() => ({ ok: true }));
  const { port } = server;
  try {
    assert.equal(await waitForIdle(port, 60), 0);
  } finally {
    await server.close();
  }
  assert.equal(await waitForIdle(port, 60), 0);
});
