import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export async function prepareWindowsConfigurationFixture({ scope, pwsh }) {
  const { inspectWindowsConfiguration } = await import('../scripts/deployment/windows-configuration.mjs');
  const project = scope.observation.project;
  const file = path.join(project, '.env.local');
  const higherPriority = path.join(project, '.env.production.local');
  const bytes = Buffer.from('nextauth_secret=fixture-private-config-secret\n'
    + 'nextauth_url=http://localhost:3010\nadmin_username=fixture\nadmin_password=fixture-private-config-password\n');
  await writeFile(file, bytes, { flag: 'wx' });
  const options = { scope, pwsh, profile: 'agents-chat-auth-638c553' };
  await assert.rejects(inspectWindowsConfiguration({ ...options, scope: { ...scope } }));
  let config = await inspectWindowsConfiguration(options);
  const entry = config.files.find(source => source.path === file);
  assert.equal(entry.present, true);
  assert.equal(typeof entry.securityDescriptor, 'string');
  assert.ok(entry.securityDescriptor.length > 0);
  assert.doesNotMatch(JSON.stringify(config), /fixture-private-config/);
  const policy = (action, descriptor) => promisify(execFile)(pwsh, [
    '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./deployment-windows-configuration-policy.ps1', import.meta.url)),
    '-File', file, '-Action', action, ...(descriptor ? ['-SecurityDescriptor', descriptor] : []),
  ], { timeout: 30000, maxBuffer: 4096 });
  try {
    await assert.rejects(rename(file, `${file}-moved`));
    await policy('broaden');
    await assert.rejects(config.checkFiles());
  } finally {
    await config.close();
    await policy('restore', entry.securityDescriptor);
  }
  assert.deepEqual(await readFile(file), bytes);
  config = await inspectWindowsConfiguration(options);
  try {
    await writeFile(higherPriority, '', { flag: 'wx' });
    await assert.rejects(config.checkFiles());
  } finally {
    await config.close();
    await unlink(higherPriority);
  }
  config = await inspectWindowsConfiguration(options);
  await config.checkFiles();
  assert.deepEqual(config.providers, ['admin-login']);
  assert.equal(config.buildEnvironment({}).NEXTAUTH_SECRET, 'fixture-private-config-secret');
  assert.equal(config.buildEnvironment({}).ADMIN_PASSWORD, 'fixture-private-config-password');
  assert.deepEqual(await readFile(file), bytes);
  return config;
}
