import { verifyRecoveryEngine } from './saved-recovery-engine.mjs';

try {
  const [control, manifestSha256, project, operationId, ...extra] = process.argv.slice(2);
  if (extra.length || !project || !operationId) throw new Error('Invalid recovery arguments.');
  await verifyRecoveryEngine({ control, manifestSha256 });
  const { recoverRetirement } = await import('./retirement-recovery.mjs');
  const result = await recoverRetirement({ control, project, operationId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write('Retirement recovery failed; retain lock and evidence for inspection.\n');
  process.exitCode = 1;
}
