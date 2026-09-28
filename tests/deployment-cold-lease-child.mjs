import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { claimLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-lease.mjs';

const [control, project, backup, pause] = process.argv.slice(2);
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (pause === 'staged' && from === path.join(control, 'cold-restore-staging')) {
    process.send({ phase: pause });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  await rename(from, to);
  if (pause === 'published' && to === path.join(control, 'recovery-lock')) {
    process.send({ phase: pause });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
};
syncBuiltinESMExports();
await claimLinuxColdRestore({ control, project, backup, acceptDataLoss: true });
throw new Error('Cold recovery lease fixture did not pause.');
