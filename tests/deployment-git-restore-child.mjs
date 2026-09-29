import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { restoreGitMetadata } from '../scripts/deployment/restore-git.mjs';

const [project, saved, pause] = process.argv.slice(2);
const record = JSON.parse(await fs.readFile(saved, 'utf8'));
const rename = fs.rename;
fs.rename = async (from, to) => {
  await rename(from, to);
  if (to === path.join(project, '.git', pause)) {
    process.send({ phase: pause });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
};
syncBuiltinESMExports();
await restoreGitMetadata({ project, record, checkStopped: async () => ({ stopped: true, inhibited: true }) });
throw new Error('Git restore child did not pause.');
