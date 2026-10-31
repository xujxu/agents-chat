import { acquireRecoveryAdmission } from '../scripts/deployment/linux-recovery-admission.mjs';

try {
  const admission = await acquireRecoveryAdmission(process.argv[2]);
  await admission.check();
  process.send({ acquired: true });
  setInterval(() => {}, 1000);
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}
