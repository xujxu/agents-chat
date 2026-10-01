import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentDiagnostics } from '../scripts/deployment/deployment-diagnostics.mjs';

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
