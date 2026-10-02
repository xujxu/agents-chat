import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [control] = process.argv.slice(2);
const recovery = path.join(control, 'recovery-engine');
const api = await import(pathToFileURL(path.join(recovery, 'windows-task-completion-proof.mjs')).href);
for (const name of ['beginWindowsDeploymentRetirement',
  'openWindowsDeploymentRetirement', 'retireNextWindowsDeploymentEntry']) {
  assert.equal(typeof api[name], 'function', `Missing native deployment retirement API: ${name}`);
}
