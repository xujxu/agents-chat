function nativeDiagnostics(value) {
  if (typeof value !== 'string') return [];
  const prefix = 'Deployment native diagnostics: ';
  const line = value.slice(-16384).split(/\r?\n/).find(line => line.startsWith(prefix));
  if (!line) return [];
  let entries;
  try { entries = JSON.parse(line.slice(prefix.length)); }
  catch { return []; }
  if (!Array.isArray(entries)) return [];
  const result = [];
  for (const entry of entries.slice(0, 8)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'code,locations'
      || typeof entry.code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(entry.code)
      || !Array.isArray(entry.locations) || entry.locations.length > 3
      || entry.locations.some(location => !location || typeof location !== 'object' || Array.isArray(location)
        || Object.keys(location).sort().join(',') !== 'column,line,module'
        || typeof location.module !== 'string' || !/^[a-z][a-z0-9-]{0,80}\.ps1$/.test(location.module)
        || ![location.line, location.column].every(value => Number.isSafeInteger(value) && value > 0 && value <= 99999999))) {
      return [];
    }
    result.push(entry);
  }
  return result;
}

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
    result.push(...nativeDiagnostics(failure.diagnostic).slice(0, 8 - result.length));
    if (failure.cause) pending.push(failure.cause);
    if (failure instanceof AggregateError) pending.push(...failure.errors.slice(0, 8));
  }
  return result;
}
