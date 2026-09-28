import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fixture, ready, systemctl } from './deployment-linux-service-fixture.mjs';
import { inspectLinuxService } from '../scripts/deployment/linux-service-inspection.mjs';
import { verifyLinuxReadiness, waitLinuxReadiness } from '../scripts/deployment/linux-readiness.mjs';

async function serving(t, { host = '127.0.0.1', response } = {}) {
  const f = await fixture(t, { nonroot: true, server: `
const fs = require('node:fs');
const server = require('node:http').createServer((req, res) => {
  fs.appendFileSync('requests', req.url + '\\n');
  ${response ?? `res.setHeader('Content-Type','application/json');res.end(JSON.stringify({
    credentials:{id:'credentials',name:'Credentials',type:'credentials',
      signinUrl:'http://localhost/api/auth/signin/credentials',callbackUrl:'http://localhost/api/auth/callback/credentials'}
  }));`}
});
server.listen(0, ${JSON.stringify(host)}, () => {
  fs.writeFileSync('port', String(server.address().port));
  fs.writeFileSync('ready', String(process.pid));
});` });
  await ready(f);
  const service = await inspectLinuxService(f);
  t.after(() => service.close());
  return { ...f, service, port: Number(await readFile(path.join(f.project, 'port'), 'utf8')) };
}

for (const host of ['127.0.0.1', '::']) {
  test(`readiness binds HTTP auth providers to an owned listener (${host})`, async t => {
    const f = await serving(t, { host });
    const result = await verifyLinuxReadiness({ service: f.service, port: f.port, providers: ['credentials'] });
    assert.equal(result.status, 'ready');
    assert.equal(result.invocationId, f.service.identity.runtime.invocationId);
    assert.equal(result.port, f.port);
    assert.deepEqual(result.providers, ['credentials']);
    assert.equal(await readFile(path.join(f.project, 'requests'), 'utf8'), '/api/auth/providers\n');
  });
}

test('healthy foreign listener cannot satisfy readiness or receive the probe', async t => {
  const f = await serving(t);
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await assert.rejects(verifyLinuxReadiness({
    service: f.service, port: server.address().port, providers: ['credentials'],
  }), /owned|listener|service/i);
  assert.equal(requests, 0);
  await f.service.check();
});

for (const [label, response] of [
  ['redirect', 'res.writeHead(302,{Location:"http://127.0.0.1:1/foreign"});res.end();'],
  ['empty providers', 'res.setHeader("Content-Type","application/json");res.end("{}");'],
  ['oversized body', 'res.setHeader("Content-Type","application/json");res.end("x".repeat(70000));'],
  ['HTML response', 'res.setHeader("Content-Type","text/html");res.end("<html>healthy</html>");'],
]) {
  test(`readiness refuses ${label} instead of claiming restored acceptance`, async t => {
    const f = await serving(t, { response });
    await assert.rejects(verifyLinuxReadiness({ service: f.service, port: f.port, providers: ['credentials'] }),
      /health|readiness|provider|response|limit/i);
    await f.service.check();
  });
}

test('cancelled readiness settles an unfinished HTTP response without stopping the service', async t => {
  const f = await serving(t, { response: 'res.writeHead(200,{"Content-Type":"application/json"});res.write("{");' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cancel health check')), 1000);
  try {
    await assert.rejects(verifyLinuxReadiness({
      service: f.service, port: f.port, providers: ['credentials'], signal: controller.signal,
    }), /cancel health check/);
  } finally { clearTimeout(timer); }
  await f.service.check();
});

test('readiness refuses a replacement generation even on the same service unit', async t => {
  const f = await serving(t);
  await systemctl('restart', f.unit);
  await assert.rejects(verifyLinuxReadiness({ service: f.service, port: f.port, providers: ['credentials'] }));
});

test('readiness waits through an owned HTTP 503 startup window before accepting providers', async t => {
  const f = await serving(t, { response: `
  const attempts = fs.readFileSync('requests','utf8').trim().split('\\n').length;
  if (attempts < 3) { res.writeHead(503); res.end('starting'); return; }
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({credentials:{id:'credentials',name:'Credentials',type:'credentials',
    signinUrl:'http://localhost/api/auth/signin/credentials',callbackUrl:'http://localhost/api/auth/callback/credentials'}}));
  ` });
  assert.equal((await waitLinuxReadiness({
    service: f.service, port: f.port, providers: ['credentials'], waitSeconds: 10,
  })).status, 'ready');
  assert.equal((await readFile(path.join(f.project, 'requests'), 'utf8')).trim().split('\n').length, 3);
});

test('readiness wait deadline closes a hanging response and leaves the managed runtime running', async t => {
  const f = await serving(t, { response: 'res.writeHead(200,{"Content-Type":"application/json"});res.write("{");' });
  await assert.rejects(waitLinuxReadiness({
    service: f.service, port: f.port, providers: ['credentials'], waitSeconds: 1,
  }), { code: 'DEPLOYMENT_STAGE_TIMEOUT', recoveryAllowed: true });
  await f.service.check();
});

test('readiness wait does not hide a provider mismatch behind startup retries', async t => {
  const f = await serving(t, { response: 'res.setHeader("Content-Type","application/json");res.end("{}");' });
  await assert.rejects(waitLinuxReadiness({
    service: f.service, port: f.port, providers: ['credentials'], waitSeconds: 10,
  }), /providers do not match/i);
  assert.equal((await readFile(path.join(f.project, 'requests'), 'utf8')).trim().split('\n').length, 1);
});
