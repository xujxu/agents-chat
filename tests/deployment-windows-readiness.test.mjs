import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { verifyWindowsReadiness, waitWindowsReadiness } from '../scripts/deployment/windows-readiness.mjs';

async function serving(t, respond) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (respond) { respond(req, res); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ 'admin-login': { id: 'admin-login', name: 'Admin', type: 'credentials',
      signinUrl: 'http://localhost/api/auth/signin/admin-login', callbackUrl: 'http://localhost/api/auth/callback/admin-login' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  return { port: server.address().port, requests: () => requests };
}

test('Windows readiness never probes a listener refused by native authority', async t => {
  const server = await serving(t);
  let attempts = 0;
  const context = {
    async listener() { attempts++; throw new Error('foreign listener refused'); },
    async check() { assert.fail('A refused listener cannot be checked as accepted'); },
  };
  await assert.rejects(waitWindowsReadiness({ context, port: server.port, providers: ['admin-login'], waitSeconds: 5 }),
    /foreign listener refused/);
  assert.equal(attempts, 1);
  assert.equal(server.requests(), 0);
});

test('Windows readiness validates provider and abort input before native requests', async () => {
  const context = { async listener() { assert.fail('Invalid input reached native authority'); } };
  await assert.rejects(verifyWindowsReadiness({ context, port: 3010, providers: [] }), /provider list/);
  const controller = new AbortController();
  controller.abort(new Error('cancel before native ownership'));
  await assert.rejects(verifyWindowsReadiness({ context, port: 3010, providers: ['admin-login'], signal: controller.signal }),
    /cancel before native ownership/);
});

test('Windows readiness retries only explicit absent-listener replies before HTTP', async t => {
  const server = await serving(t);
  const generation = randomUUID();
  let attempts = 0;
  let checks = 0;
  const context = {
    async listener({ port }) {
      assert.equal(port, server.port);
      attempts++;
      return attempts < 3 ? { status: 'not-ready' } : { status: 'retained', generation, port };
    },
    async check() { checks++; assert.equal(server.requests(), 1); },
  };
  const result = await waitWindowsReadiness({ context, port: server.port, providers: ['admin-login'], waitSeconds: 5 });
  assert.deepEqual(result, { status: 'ready', generation, port: server.port, providers: ['admin-login'] });
  assert.equal(attempts, 3);
  assert.equal(checks, 1);
  assert.equal(server.requests(), 1);
});

test('Windows readiness rejects ownership loss after a healthy HTTP response', async t => {
  const server = await serving(t);
  const context = {
    async listener({ port }) { return { status: 'retained', generation: randomUUID(), port }; },
    async check() { throw new Error('original listener binding changed'); },
  };
  await assert.rejects(verifyWindowsReadiness({ context, port: server.port, providers: ['admin-login'] }),
    /original listener binding changed/);
  assert.equal(server.requests(), 1);
});

test('Windows readiness overall deadline closes an unfinished HTTP response', async t => {
  const server = await serving(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.write('{'); });
  const context = {
    async listener({ port }) { return { status: 'retained', generation: randomUUID(), port }; },
    async check() { assert.fail('Incomplete HTTP cannot be accepted'); },
  };
  await assert.rejects(waitWindowsReadiness({ context, port: server.port, providers: ['admin-login'], waitSeconds: 1 }),
    { code: 'DEPLOYMENT_STAGE_TIMEOUT', recoveryAllowed: true });
  assert.equal(server.requests(), 1);
});
