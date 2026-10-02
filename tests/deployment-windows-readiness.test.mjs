import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { verifyWindowsReadiness, waitWindowsReadiness } from '../scripts/deployment/windows-readiness.mjs';
import { completeWindowsTaskActivation } from '../scripts/deployment/windows-task-completion.mjs';

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

test('Windows completion publishes state only after native-bound HTTP and preparation', async t => {
  const server = await serving(t);
  const calls = [];
  const stateSha256 = 'a'.repeat(64);
  const context = {
    async listener({ port }) {
      calls.push('listener');
      return { status: 'retained', generation: randomUUID(), port };
    },
    async check() { assert.equal(server.requests(), 1); calls.push('checked'); },
    async prepareCompletion({ port, providers }) {
      assert.equal(port, server.port);
      assert.deepEqual(providers, ['admin-login']);
      calls.push('prepared');
    },
    async complete(value) { assert.equal(value.stateSha256, stateSha256); calls.push('completed'); },
    async close() { assert.fail('Successful completion does not close its authority'); },
  };
  const result = await completeWindowsTaskActivation({
    context, port: server.port, providers: ['admin-login'],
    async recordAcceptance() { calls.push('recorded'); return stateSha256; },
  });
  assert.deepEqual(result, { status: 'completed', stateSha256 });
  assert.deepEqual(calls, ['listener', 'checked', 'prepared', 'recorded', 'completed']);
});

test('Windows completion preserves refusal and settles prepared authority on publication failure', async t => {
  const server = await serving(t);
  const failure = new Error('acceptance publication failed');
  let closed = false;
  const context = {
    async listener({ port }) { return { status: 'retained', generation: randomUUID(), port }; },
    async check() {},
    async prepareCompletion() {},
    async complete() { assert.fail('Unpublished acceptance cannot release runtime'); },
    async close() { closed = true; },
  };
  await assert.rejects(completeWindowsTaskActivation({
    context, port: server.port, providers: ['admin-login'],
    async recordAcceptance() { throw failure; },
  }), error => error === failure);
  assert.equal(closed, true);
});

test('Windows completion exposes both publication and authority cleanup failures', async t => {
  const server = await serving(t);
  const failure = new Error('acceptance publication failed');
  const cleanup = new Error('authority cleanup uncertain');
  const context = {
    async listener({ port }) { return { status: 'retained', generation: randomUUID(), port }; },
    async check() {},
    async prepareCompletion() {},
    async close() { throw cleanup; },
  };
  await assert.rejects(completeWindowsTaskActivation({
    context, port: server.port, providers: ['admin-login'],
    async recordAcceptance() { throw failure; },
  }), error => error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === cleanup);
});
