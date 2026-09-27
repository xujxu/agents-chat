const maximumNodes = 256;

export function hasUnsettledWorker(error) {
  const pending = [error];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    if (seen.size >= maximumNodes) return true;
    seen.add(current);
    try {
      const fields = ['recoveryAllowed', 'cause', 'errors'].map(key =>
        Object.getOwnPropertyDescriptor(current, key));
      if (fields.some(field => field && !Object.hasOwn(field, 'value'))) return true;
      if (fields[0]?.value === false) return true;
      if (fields[1]) pending.push(fields[1].value);
      const errors = fields[2]?.value;
      if (errors !== undefined) {
        if (!Array.isArray(errors)) return true;
        const length = Object.getOwnPropertyDescriptor(errors, 'length')?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > maximumNodes) return true;
        for (let index = 0; index < length; index++) {
          const entry = Object.getOwnPropertyDescriptor(errors, String(index));
          if (!entry || !Object.hasOwn(entry, 'value')) return true;
          pending.push(entry.value);
        }
      }
    } catch {
      // Uninspectable errors forbid recovery just like unconfirmed worker exit.
      return true;
    }
  }
  return false;
}
