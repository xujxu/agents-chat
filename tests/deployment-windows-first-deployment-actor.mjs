import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { acquireLock, loadState } from '../scripts/deployment/state.mjs';
import { inspectWindowsFirstInstall } from '../scripts/deployment/windows-first-install.mjs';
import { inspectWindowsFirstConfiguration } from '../scripts/deployment/windows-configuration.mjs';
import { runWindowsFirstDeployment } from '../scripts/deployment/windows-first-deployment.mjs';
import { loginDeploymentFixture } from './deployment-http-fixture.mjs';

const [project, control, taskName, pwsh, git, npmCli, revision, chatId, operationId] = process.argv.slice(2);
assert.match(operationId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const scope = await inspectWindowsFirstInstall({ project, taskName, pwsh });
let configuration;
let result;
try {
  configuration = await inspectWindowsFirstConfiguration({ scope, pwsh, profile: 'agents-chat-auth-638c553' });
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project, operationId, pwsh });
  const environment = {};
  const permitted = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']);
  for (const [key, value] of Object.entries(process.env)) if (permitted.has(key.toUpperCase())) environment[key] = value;
  environment.HOME = path.dirname(project);
  environment.NEXT_TELEMETRY_DISABLED = '1';
  environment.npm_config_cache = path.join(path.dirname(project), 'npm-cache');
  const options = {
    scope, configuration, control, lock, node: process.execPath, npmCli, git, pwsh, environment,
    port: 3010, deploymentBytes: 2 * 1024 ** 3, revision, waitSeconds: 120, timeoutSeconds: 900,
    ...(process.env.DEPLOYMENT_TEST_WINDOWS_FIRST_DEFAULT_POLICY === '1'
      ? {} : { logonType: 'S4U', triggerType: 'AtStartup' }),
  };
  const before = (await readdir(control)).sort();
  await assert.rejects(runWindowsFirstDeployment({ ...options, noInstall: true }), /dependencies/);
  assert.deepEqual((await readdir(control)).sort(), before);
  assert.equal(await loadState(control), null);
  result = { ...await runWindowsFirstDeployment(options), operationId: lock.operationId };
  const api = await loginDeploymentFixture();
  assert.equal((await api('/api/chats', { chat: {
    id: chatId, name: 'Fresh Windows deployment', ts: Date.now(), agentSessions: {},
    messages: [{ id: 'first', type: 'user', content: 'First deployment data survives closeout', ts: Date.now() }],
  } })).ok, true);
} finally {
  try { await configuration?.close(); }
  finally { await scope.close(); }
}
process.stdout.write(`${JSON.stringify(result)}\n`);
