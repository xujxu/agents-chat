import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { restoreGitMetadata } from '../scripts/deployment/restore-git.mjs';

const [project, saved, pause, backup] = process.argv.slice(2);
const record = JSON.parse(await fs.readFile(saved, 'utf8'));
const paused = async () => {
  process.send({ phase: pause });
  await new Promise(() => { setInterval(() => {}, 1000); });
};
const rename = fs.rename;
fs.rename = async (from, to) => {
  await rename(from, to);
  if (record.version === 1 && to === path.join(project, '.git', pause)) await paused();
};
syncBuiltinESMExports();
await restoreGitMetadata({
  project, backup, record,
  checkStopped: async () => {
    if (record.version === 2) {
      let proof;
      try { proof = JSON.parse(await fs.readFile(path.join(project, '.git/agents-chat-restore/intent.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const entry = proof?.entries.find(entry => entry.file === pause);
      if (entry) {
        const actual = await fs.lstat(path.join(project, '.git', pause), { bigint: true });
        if (String(actual.dev) === entry.staged.dev && String(actual.ino) === entry.staged.ino) {
          await paused();
        }
      }
    }
    return { stopped: true, inhibited: true };
  },
});
throw new Error('Git restore child did not pause.');
