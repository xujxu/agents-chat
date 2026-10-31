import { restoreLinuxColdFiles } from '../scripts/deployment/linux-cold-restore-files.mjs';
import { activateLinuxColdRestore } from '../scripts/deployment/linux-cold-restore-activation.mjs';

const [control, project, backup, port] = process.argv.slice(2);
const restored = await restoreLinuxColdFiles({ control, project, backup, acceptDataLoss: true, timeoutSeconds: 90 });
const active = await activateLinuxColdRestore({ restored, port: Number(port), waitSeconds: 10, timeoutSeconds: 90 });
await active.check();
process.send({ phase: active.status, identity: active.identity });
setInterval(() => {}, 1000);
