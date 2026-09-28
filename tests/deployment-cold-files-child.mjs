import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { restoreLinuxColdFiles } from '../scripts/deployment/linux-cold-restore-files.mjs';

const [control, project, backup] = process.argv.slice(2);
const unlink = fs.unlink;
fs.unlink = async file => {
  await unlink(file);
  if (file === path.join(project, 'saved-data')) {
    process.send({ phase: 'project-removal' });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
};
syncBuiltinESMExports();
await restoreLinuxColdFiles({ control, project, backup, acceptDataLoss: true, timeoutSeconds: 90 });
throw new Error('Cold file restore fixture did not pause.');
