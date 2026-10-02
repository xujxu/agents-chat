import { verifyRecoveryEngine } from './saved-recovery-engine.mjs';

try {
  const [control, manifestSha256, project, operationId, kind = 'worker', ...extra] = process.argv.slice(2);
  const pwsh = process.platform === 'win32' ? extra[0] : undefined;
  if (!project || !operationId || !['worker', 'service'].includes(kind)
    || (process.platform === 'win32' ? extra.length !== 1 || kind !== 'worker' || !pwsh : extra.length !== 0)) {
    throw new Error('Invalid recovery arguments.');
  }
  await verifyRecoveryEngine({ control, manifestSha256 });
  const recover = kind === 'service'
    ? (await import('./linux-service-recovery.mjs')).recoverLinuxServiceRetirement
    : (await import('./retirement-recovery.mjs')).recoverRetirement;
  const result = await recover({ control, project, operationId, ...(pwsh ? { pwsh } : {}) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write('Retirement recovery failed; retain lock and evidence for inspection.\n');
  const pending = [error];
  for (let count = 0; pending.length && count < 8; count++) {
    const failure = pending.shift();
    const code = typeof failure?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(failure.code) ? failure.code : 'UNKNOWN';
    const syscall = typeof failure?.syscall === 'string' && /^[a-z_]{1,32}$/.test(failure.syscall) ? failure.syscall : 'none';
    process.stderr.write(`Recovery diagnostic: code=${code} syscall=${syscall}\n`);
    if (failure?.cause) pending.push(failure.cause);
    if (failure instanceof AggregateError) pending.push(...failure.errors.slice(0, 8));
  }
  process.exitCode = 1;
}
