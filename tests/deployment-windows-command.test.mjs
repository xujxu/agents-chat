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

test('Windows first command admits explicit NoTunnel policy before requiring native context', async () => {
  for (const args of [
    ['--no-tunnel'],
    ['--no-tunnel', '--task-logon-type', 'Interactive', '--task-trigger-type', 'AtLogOn'],
    ['--no-tunnel', '--task-logon-type', 'S4U', '--task-trigger-type', 'AtStartup'],
  ]) {
    await assert.rejects(runWindowsDeploymentCommand({ operation: 'deploy', args }),
      { code: 'DEPLOYMENT_WINDOWS_COMMAND_CONTEXT_REQUIRED' });
  }
});

test('Windows first command rejects policy conflicts before installation access', async () => {
  for (const [operation, args] of [
    ['update', ['--no-tunnel']],
    ['deploy', ['--task-logon-type', 'S4U']],
    ['deploy', ['--task-trigger-type', 'AtStartup']],
    ['deploy', ['--no-tunnel', '--status']],
    ['deploy', ['--no-tunnel', '--verify']],
    ['deploy', ['--no-tunnel', '--dry-run']],
    ['deploy', ['--no-tunnel', '--no-install']],
    ['deploy', ['--no-tunnel', '--task-logon-type', 'Password']],
    ['deploy', ['--no-tunnel', '--task-trigger-type', 'Daily']],
  ]) {
    await assert.rejects(runWindowsDeploymentCommand({ operation, args }),
      { code: 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED' });
  }
});

test('Windows first command rejects duplicate or missing policy values', async () => {
  for (const args of [
    ['--no-tunnel', '--no-tunnel'],
    ['--no-tunnel', '--task-logon-type', 'S4U', '--task-logon-type', 'Interactive'],
    ['--no-tunnel', '--task-trigger-type', 'AtStartup', '--task-trigger-type', 'AtLogOn'],
  ]) {
    await assert.rejects(runWindowsDeploymentCommand({ operation: 'deploy', args }), /Duplicate/);
  }
  for (const args of [
    ['--no-tunnel', '--task-logon-type'],
    ['--no-tunnel', '--task-trigger-type'],
  ]) {
    await assert.rejects(runWindowsDeploymentCommand({ operation: 'deploy', args }),
      { code: 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED' });
  }
});
