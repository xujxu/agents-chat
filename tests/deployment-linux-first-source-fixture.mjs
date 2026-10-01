import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chown, chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { inspectLinuxFirstInstall } from '../scripts/deployment/linux-first-install.mjs';
import { acquireLock } from '../scripts/deployment/state.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));

export async function freshSourceInstallationFixture(t, { unit = `agents-first-${randomUUID()}.service` } = {}) {
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
    await chown(directory, 65534, 65534);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await own(file);
      else if (entry.isFile()) await chown(file, 65534, 65534);
      else throw new Error('Unexpected fresh-source fixture link.');
    }
  };
  await own(project);
  const home = path.join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  await chown(home, 65534, 65534);
  const controller = new AbortController();
  const installation = await inspectLinuxFirstInstall({
    project, unit, signal: controller.signal,
  });
  const control = path.join(root, '.fresh app.deployment');
  await mkdir(control, { mode: 0o700 });
  const lock = await acquireLock(control, { project, operationId: randomUUID() });
  return { root, project, home, controller, installation, control, lock };
}
