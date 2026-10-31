import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chown, chmod, mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectLinuxFirstInstall } from '../scripts/deployment/linux-first-install.mjs';
import { acquireLock, captureLockOwner } from '../scripts/deployment/state.mjs';
import { linuxNative, linuxSystemdProperties } from '../scripts/deployment/linux-systemd.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));

export async function freshSourceInstallationFixture(t, {
  unit = `agents-first-${randomUUID()}.service`, uid = 65534, gid = 65534,
} = {}) {
  const root = await temporaryDeployment(t);
  await chmod(root, 0o755);
  const project = path.join(root, 'fresh app');
  await execute('/usr/bin/git', ['clone', '--quiet', '--no-hardlinks', repository, project],
    { timeout: 60000, maxBuffer: 16384 });
  await writeFile(path.join(project, '.env.local'), [
    'NEXTAUTH_SECRET=fresh-build-private-secret', 'NEXTAUTH_URL=http://localhost:3010',
    'ADMIN_USERNAME=fixture', 'ADMIN_PASSWORD=fresh-build-private-password', '',
  ].join('\n'), { mode: 0o600 });
  const own = async directory => {
    await chown(directory, uid, gid);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await own(file);
      else if (entry.isFile()) await chown(file, uid, gid);
      else throw new Error('Unexpected fresh-source fixture link.');
    }
  };
  await own(project);
  const home = path.join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  await chown(home, uid, gid);
  const controller = new AbortController();
  const installation = await inspectLinuxFirstInstall({
    project, unit, signal: controller.signal,
  });
  const control = path.join(root, '.fresh app.deployment');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  return { root, project, home, controller, installation, control, lock };
}

export async function removeFirstSourceUnit(f) {
  const { unit } = f.installation.identity;
  const fragment = `/etc/systemd/system/${unit}`;
  const inhibition = `${fragment}.d/90-agents-chat-deployment.conf`;
  let owner = f.lock;
  try { owner = captureLockOwner(JSON.parse(await readFile(path.join(f.control, 'lock/owner.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(owner.project, f.project);
  const current = await linuxSystemdProperties(unit, ['LoadState', 'FragmentPath'], { allowMissing: true });
  if (current.LoadState !== 'not-found') {
    assert.equal(current.FragmentPath, fragment);
    await linuxNative('/usr/bin/systemctl', ['--system', 'stop', unit]);
  }
  for (const file of [`/etc/systemd/system/multi-user.target.wants/${unit}`,
    `${inhibition}.${owner.token}.held`, inhibition, fragment]) {
    try { await unlink(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { await rmdir(path.dirname(inhibition)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await linuxNative('/usr/bin/systemctl', ['--system', 'daemon-reload']);
}
