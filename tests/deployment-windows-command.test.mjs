import assert from 'node:assert/strict';
import test from 'node:test';
import { runWindowsDeploymentCommand } from '../scripts/deployment/windows-deployment-command.mjs';

test('Windows command help requires no runtime, tools or control directory', async () => {
  for (const operation of ['deploy', 'update']) {
    const result = await runWindowsDeploymentCommand({ operation, args: ['--help'] });
    assert.equal(result.status, 'help');
    assert.match(result.message, /existing running managed tasks/);
  }
});

test('Windows unsupported command modes refuse before native admission', async () => {
  for (const operation of ['deploy', 'update']) {
    for (const args of [['--wait', '0'], ['--verify'], ['--dry-run']]) {
      await assert.rejects(runWindowsDeploymentCommand({ operation, args }),
        { code: 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED' });
    }
  }
});

test('Windows command arguments are validated before access to installation state', async () => {
  for (const operation of ['restore', 'status', undefined]) {
    await assert.rejects(runWindowsDeploymentCommand({ operation, args: [] }),
      /Unsupported Windows deployment command/);
  }
  for (const args of [['--unknown'], ['--timeout', '0'], ['--revision', 'main'],
    ['--revision', 'a'.repeat(40), '--no-pull'], ['--accept-data-loss']]) {
    await assert.rejects(runWindowsDeploymentCommand({ operation: 'update', args }));
  }
});

test('Windows command does not discover missing native context from inherited environment', async () => {
  for (const args of [[], ['--status']]) {
    await assert.rejects(runWindowsDeploymentCommand({ operation: 'update', args }),
      { code: 'DEPLOYMENT_WINDOWS_COMMAND_CONTEXT_REQUIRED' });
  }
});
