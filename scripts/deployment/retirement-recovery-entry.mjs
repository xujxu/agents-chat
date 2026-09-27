import { verifyRecoveryEngine } from './saved-recovery-engine.mjs';

try {
  const [control, manifestSha256, project, operationId, kind = 'worker', ...extra] = process.argv.slice(2);
  if (extra.length || !project || !operationId || !['worker', 'service'].includes(kind)) throw new Error('Invalid recovery arguments.');
  await verifyRecoveryEngine({ control, manifestSha256 });
  const recover = kind === 'service'
    ? (await import('./linux-service-recovery.mjs')).recoverLinuxServiceRetirement
    : (await import('./retirement-recovery.mjs')).recoverRetirement;
  const result = await recover({ control, project, operationId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write('Retirement recovery failed; retain lock and evidence for inspection.\n');
  process.exitCode = 1;
}
