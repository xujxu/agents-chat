import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function temporaryDeployment(t) {
  const temporary = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(temporary, 'agents-deployment-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
