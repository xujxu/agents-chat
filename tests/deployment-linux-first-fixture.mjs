import { chmod, chown, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { temporaryDeployment } from './deployment-fixture.mjs';

export async function freshInstallationFixture(t) {
  const root = await temporaryDeployment(t);
  await chmod(root, 0o755);
  const project = path.join(root, 'fresh app');
  await mkdir(project, { mode: 0o755 });
  await chown(project, 65534, 65534);
  const env = path.join(project, '.env.local');
  await writeFile(env, [
    'NEXTAUTH_SECRET=first-install-private-secret',
    'NEXTAUTH_URL=http://localhost:3010',
    'ADMIN_USERNAME=fixture', 'ADMIN_PASSWORD=first-install-private-password', '',
  ].join('\n'), { mode: 0o600 });
  await chown(env, 65534, 65534);
  return { root, project, unit: `agents-first-${randomUUID()}.service`,
    control: path.join(root, '.fresh app.deployment'), env };
}
