import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { restoreLinuxColdFiles } from '../scripts/deployment/linux-cold-restore-files.mjs';
import { activateLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-activation.mjs';
import { completeLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-completion.mjs';

const [control, project, backup, port, phase] = process.argv.slice(2);
const restored = await restoreLinuxColdFiles({ control, project, backup, acceptDataLoss: true, timeoutSeconds: 90 });
const active = await activateLinuxColdRestore({ restored, port: Number(port), waitSeconds: 10, timeoutSeconds: 90 });
const pause = async () => {
  process.send({ phase, identity: active.identity });
  await new Promise(() => { setInterval(() => {}, 1000); });
};
const rename = fs.rename;
const unlink = fs.unlink;
const rmdir = fs.rmdir;
fs.rename = async (source, target) => {
  await rename(source, target);
  if (phase === 'state-published' && target === path.join(control, 'state.json')) await pause();
};
fs.unlink = async file => {
  await unlink(file);
  if (phase === 'lock-owner-removed' && file === path.join(control, 'lock/owner.json')) await pause();
};
fs.rmdir = async file => {
  await rmdir(file);
  if (phase === 'guard-removed' && file === path.join(control, 'recovery-lock')) await pause();
};
syncBuiltinESMExports();
await completeLinuxColdRestore({ control, project, backup, restored, active, waitSeconds: 10, timeoutSeconds: 90 });
throw new Error('Cold completion did not pause.');
