import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { inspectWindowsManagedTask } from '../scripts/deployment/windows-managed-task.mjs';
import { inspectTargetCompatibility } from '../scripts/deployment/target-compatibility.mjs';
import { readWorkerFile } from '../scripts/deployment/worker-files.mjs';

const [project, taskName, pwsh, git] = process.argv.slice(2);
const scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
try {
  const observed = scope.observation;
  assert.equal(observed.enabled, true);
  const bytes = await readWorkerFile(observed.configuration, 1024 * 1024, { privateMode: true });
  assert.equal(createHash('sha256').update(bytes).digest('hex'), observed.configurationSha256);
  const configuration = JSON.parse(bytes);
  assert.equal(await realpath(configuration.command.file), await realpath(process.execPath));
  const { stdout } = await promisify(execFile)(git, ['-C', project, 'rev-parse', 'HEAD'], {
    timeout: 30000, maxBuffer: 1024,
  });
  const commit = stdout.trim();
  const options = { project, commit, nodeVersion: process.versions.node, platform: process.platform, git };
  const target = await inspectTargetCompatibility(options);
  assert.equal(target.status, 'target-supported');
  assert.equal(target.commit, commit);
  assert.equal(target.mode, 'declared');
  assert.equal(target.configurationProfile, 'agents-chat-auth-638c553');
  assert.equal(target.databaseProfile, 'agents-chat-638c553');
  await assert.rejects(inspectTargetCompatibility({
    ...options, git: path.join(path.dirname(git), `${randomUUID()}-missing-git.exe`),
  }), { code: 'DEPLOYMENT_TARGET_UNSUPPORTED', check: 'target-inspection-unavailable' });
  await scope.check();
  console.log('PASS: actual managed Windows application target preflight uses explicit Git with minimal PATH and preserves its running task');
} finally {
  await scope.close();
}
