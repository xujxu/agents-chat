import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function temporaryDeployment(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agents-deployment-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
