export function deploymentDiagnostics(error, moduleRoots) {
  const pending = [error];
  const seen = new Set();
  const result = [];
  while (pending.length && result.length < 8) {
    const failure = pending.shift();
    if (!failure || typeof failure !== 'object' || seen.has(failure)) continue;
    seen.add(failure);
    const locations = [];
    const stack = typeof failure.stack === 'string' ? failure.stack.slice(0, 16384) : '';
    for (const frame of stack.split('\n').slice(1, 65)) {
      if (!/^\s+at /.test(frame)) continue;
      for (const root of moduleRoots) {
        const start = frame.indexOf(root);
        if (start < 0) continue;
        const match = frame.slice(start + root.length)
          .match(/^([a-z][a-z0-9-]{0,80}\.mjs):([1-9][0-9]{0,7}):([1-9][0-9]{0,7})\)?$/);
        if (!match) continue;
        const location = { module: match[1], line: Number(match[2]), column: Number(match[3]) };
        if (!locations.some(value => value.module === location.module
          && value.line === location.line && value.column === location.column)) locations.push(location);
        break;
      }
      if (locations.length === 3) break;
    }
    result.push({
      code: typeof failure.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(failure.code) ? failure.code : 'UNKNOWN',
      locations,
    });
    if (failure.cause) pending.push(failure.cause);
    if (failure instanceof AggregateError) pending.push(...failure.errors.slice(0, 8));
  }
  return result;
}
