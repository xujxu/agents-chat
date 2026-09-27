const identityFields = ['source', 'build', 'dependencies', 'config', 'service'];

export function alreadyCurrent(facts) {
  if (facts?.operation !== 'update') return { skip: false, reason: 'explicit-deploy' };
  if (facts.phase !== 'accepted' || facts.receipt?.status !== 'accepted') {
    return { skip: false, reason: 'unaccepted-state' };
  }
  if (facts.observed?.verified !== true || facts.observed.running !== true) {
    return { skip: false, reason: 'runtime-unverified' };
  }
  const accepted = facts.receipt.identity;
  const observed = facts.observed.identity;
  for (const field of identityFields) {
    if (typeof accepted?.[field] !== 'string' || !accepted[field].trim()
      || observed?.[field] !== accepted[field]) {
      return { skip: false, reason: `identity-mismatch:${field}` };
    }
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(facts.target ?? '')
    || facts.target !== observed.source) {
    return { skip: false, reason: 'target-mismatch' };
  }
  return { skip: true, reason: 'accepted-identities-match' };
}

export async function previewUpdate(options, readers) {
  if (!['deploy', 'update'].includes(options?.operation) || options.dryRun !== true) {
    throw new Error('Preview requires deploy or update with dry-run.');
  }
  if (!readers || ['inspect', 'localTarget', 'estimate', 'checks']
    .some(name => typeof readers[name] !== 'function')) {
    throw new Error('Preview requires read-only inspection readers.');
  }
  const inspection = await readers.inspect(options);
  const target = await readers.localTarget(options, inspection);
  if (target !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target?.commit ?? '')) {
    throw new Error('Invalid preview target inspection.');
  }
  const estimate = await readers.estimate(options, inspection, target);
  const checks = await readers.checks(options, inspection, target);
  if (!Array.isArray(checks) || checks.some(check =>
    !check || !/^[a-z][a-z0-9-]{0,63}$/.test(check.name ?? '')
    || !['passed', 'pending', 'failed'].includes(check.status))) {
    throw new Error('Invalid preview compatibility check result.');
  }
  const failed = checks.filter(check => check.status === 'failed').map(check => check.name);
  if (failed.length) throw new Error(`Preview compatibility checks failed: ${failed.join(', ')}.`);
  const pendingChecks = checks.filter(check => check.status === 'pending').map(check => check.name);
  if (target === null) pendingChecks.push('target');
  if (!options.noPull && !options.revision) pendingChecks.push('remote-freshness');
  return {
    status: 'preview', inspection, target, estimate, checks,
    remoteRefreshed: false, pendingChecks: [...new Set(pendingChecks)],
  };
}
