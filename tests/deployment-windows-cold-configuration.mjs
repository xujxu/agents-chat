import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export async function verifyWindowsColdConfiguration({ lease, project, pwsh }) {
  const environment = path.join(project, '.env.local');
  const bytes = await readFile(environment);
  try {
    await writeFile(environment, Buffer.concat([bytes, Buffer.from('\n# changed after restoration\n')]));
    await assert.rejects(lease.inspectRestoredConfiguration(), /Restored configuration differs/);
  } finally { await writeFile(environment, bytes); }
  const extra = path.join(project, '.env.production.local');
  await assert.rejects(lstat(extra), { code: 'ENOENT' });
  try {
    await writeFile(extra, '# no provider overrides\n');
    await assert.rejects(lease.inspectRestoredConfiguration(), /Restored configuration differs/);
  } finally { await unlink(extra); }
  const toggleHidden = () => promisify(execFile)(pwsh, ['-NoProfile', '-NonInteractive', '-Command',
    '[IO.File]::SetAttributes($env:AGENTS_TEST_CONFIG, ([IO.File]::GetAttributes($env:AGENTS_TEST_CONFIG) -bxor [IO.FileAttributes]::Hidden))'],
  { env: { ...process.env, AGENTS_TEST_CONFIG: environment }, timeout: 15000 });
  await toggleHidden();
  try {
    await assert.rejects(lease.inspectRestoredConfiguration(), /Restored configuration security differs/);
  } finally { await toggleHidden(); }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lease.inspectRestoredConfiguration({ signal: controller.signal }), { name: 'AbortError' });
  await lease.checkStopped();
  const configuration = await lease.inspectRestoredConfiguration();
  try {
    assert.equal(configuration.profile, 'agents-chat-auth-638c553');
    assert.deepEqual(configuration.providers, lease.providers);
    await configuration.checkFiles();
    await assert.rejects(writeFile(environment, 'changed'));
    assert.deepEqual(await readFile(environment), bytes);
    return configuration;
  } catch (error) {
    await configuration.close();
    throw error;
  }
}
