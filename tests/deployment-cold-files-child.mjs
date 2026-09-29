import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { restoreLinuxColdFiles } from '../scripts/deployment/linux-cold-restore-files.mjs';

const [control, project, backup, pause = 'project-removal'] = process.argv.slice(2);
const paused = async () => {
  process.send({ phase: pause });
  await new Promise(() => { setInterval(() => {}, 1000); });
};
const unlink = fs.unlink;
fs.unlink = async file => {
  await unlink(file);
  if (pause === 'project-removal' && file === path.join(project, 'saved-data')) await paused();
};
const rename = fs.rename;
fs.rename = async (source, target) => {
  await rename(source, target);
  if (pause === 'git-index' && target === path.join(project, '.git', 'index')) await paused();
};
syncBuiltinESMExports();
await restoreLinuxColdFiles({ control, project, backup, acceptDataLoss: true, timeoutSeconds: 90 });
throw new Error('Cold file restore fixture did not pause.');
