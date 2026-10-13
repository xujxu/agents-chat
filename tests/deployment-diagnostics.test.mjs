import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deploymentDiagnostics } from '../scripts/deployment/deployment-diagnostics.mjs';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

const root = 'file:///private/controller%20helpers/';

test('deployment diagnostics expose bounded owned locations, not error text, paths or native output', () => {
  const error = Object.assign(new Error('private-fixture-password'), {
    code: 'DEPLOYMENT_COMMAND_FAILED',
    result: { stderr: 'private-fixture-secret' },
    stack: `Error: private-fixture-password
    at fail (${root}linux-deployment.mjs:151:19)
    at /untrusted/private-fixture-secret.mjs:20:2
    at async ${root}linux-deployment-command.mjs:130:9`,
  });
  assert.deepEqual(deploymentDiagnostics(error, [root]), [{
    code: 'DEPLOYMENT_COMMAND_FAILED',
    locations: [
      { module: 'linux-deployment.mjs', line: 151, column: 19 },
      { module: 'linux-deployment-command.mjs', line: 130, column: 9 },
    ],
  }]);
  assert.doesNotMatch(JSON.stringify(deploymentDiagnostics(error, [root])), /private|file:|stderr|password|secret/);
});

test('deployment diagnostics bound cyclic causes and aggregate errors without accepting arbitrary codes', () => {
  const causes = Array.from({ length: 30 }, () => Object.assign(new Error('secret'), {
    code: 'bad secret code',
    stack: `Error: secret\n${Array.from({ length: 30 }, () => `    at ${root}state.mjs:10:2`).join('\n')}`,
  }));
  const error = new AggregateError(causes, 'private message', { cause: causes[0] });
  causes[0].cause = error;
  const result = deploymentDiagnostics(error, [root]);
  assert.equal(result.length, 8);
  assert.ok(result.every(item => item.code === 'UNKNOWN' && item.locations.length <= 3));
  assert.ok(result.slice(1).every(item => item.locations.length === 1));
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
});

test('deployment diagnostics ignore lookalike roots, nested paths and malformed locations', () => {
  const error = Object.assign(new Error('secret'), {
    stack: `Error: secret
    at file:///private/controller%20helpers-foreign/state.mjs:1:2
    at ${root}nested/state.mjs:1:2
    at ${root}state.mjs:0:2
    at ${root}state.mjs:1:0`,
  });
  assert.deepEqual(deploymentDiagnostics(error, [root]), [{ code: 'UNKNOWN', locations: [] }]);
});

test('deployment diagnostics retain bounded native locations without forwarding native error text', () => {
  const native = {
    code: 'INVALIDOPERATIONEXCEPTION',
    locations: [{ module: 'windows-stopped-restore-proof.ps1', line: 123, column: 1 }],
  };
  const error = Object.assign(new Error('private message'), {
    diagnostic: `private native stderr\nDeployment native diagnostics: ${JSON.stringify([native])}\n`,
  });
  assert.deepEqual(deploymentDiagnostics(error, [root]), [{ code: 'UNKNOWN', locations: [] }, native]);
  assert.doesNotMatch(JSON.stringify(deploymentDiagnostics(error, [root])), /private|stderr/);
  for (const value of [
    '{invalid', JSON.stringify([{ ...native, code: 'private message' }]),
    JSON.stringify([{ ...native, extra: 'private message' }]),
    JSON.stringify([{ ...native, locations: [{ module: '../private.ps1', line: 1, column: 1 }] }]),
    JSON.stringify([{ ...native, locations: [{ module: 'valid.ps1', line: 0, column: 1 }] }]),
  ]) {
    error.diagnostic = `Deployment native diagnostics: ${value}\n`;
    assert.deepEqual(deploymentDiagnostics(error, [root]), [{ code: 'UNKNOWN', locations: [] }]);
  }
  error.diagnostic = `Deployment native diagnostics: ${JSON.stringify(Array(30).fill(native))}\n`;
  assert.equal(deploymentDiagnostics(error, [root]).length, 8);
});

test('native stopped restore refusal emits owned locations without exposing its control path', {
  skip: process.platform !== 'win32',
}, async () => {
  const script = fileURLToPath(new URL('../scripts/deployment/windows-stopped-restore-controller.ps1', import.meta.url));
  const identity = await processIdentity(process.pid);
  await assert.rejects(promisify(execFile)(process.env.DEPLOYMENT_TEST_PWSH, [
    '-NoProfile', '-NonInteractive', '-File', script, '-Control', 'PRIVATE_NONCANONICAL_CONTROL',
    '-ControllerPid', String(process.pid), '-ControllerIdentity', identity,
  ], { timeout: 60000, maxBuffer: 32768 }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.killed, false);
    assert.equal(error.stdout, '');
    const diagnostics = deploymentDiagnostics({ diagnostic: error.stderr }, [root]);
    assert.ok(diagnostics.some(value => value.locations.some(location =>
      location.module === 'windows-stopped-restore-proof.ps1')), JSON.stringify(diagnostics));
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_NONCANONICAL_CONTROL|[\\/]/);
    return true;
  });
});
