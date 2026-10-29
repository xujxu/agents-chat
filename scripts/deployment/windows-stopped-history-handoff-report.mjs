const kinds = ['prepared', 'committed', 'abandoned', 'lock-retirement', 'lock-retired', 'state-intent'];
const pattern = new RegExp(
  `^inactive-handoff-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(${kinds.join('|')})\\.json$`);
const zero = '00000000-0000-0000-0000-000000000000';

function attemptStatus(records) {
  if (!records.includes('prepared')) return 'incomplete';
  if (records.includes('state-intent')) return 'state-transition';
  if (records.includes('lock-retired')) return 'lock-settled';
  if (records.includes('lock-retirement')) return 'lock-retiring';
  if (records.includes('abandoned')) return 'abandoned';
  if (records.includes('committed')) return 'committed';
  return 'prepared';
}

// Name-only report: record bytes are never read or trusted, so it cannot grant any authority.
export function describeWindowsStoppedHistoryHandoffEntries(names) {
  const attempts = new Map();
  const unrecognized = [];
  for (const name of names) {
    const entry = String(name).toLowerCase();
    if (!entry.startsWith('inactive-handoff-')) continue;
    const match = pattern.exec(entry);
    if (!match || match[1] === zero) {
      unrecognized.push(String(name));
      continue;
    }
    if (!attempts.has(match[1])) attempts.set(match[1], new Set());
    attempts.get(match[1]).add(match[2]);
  }
  if (attempts.size === 0 && unrecognized.length === 0) return null;
  return Object.freeze({
    authority: false,
    attempts: Object.freeze([...attempts.keys()].sort().map(attemptId => {
      const records = Object.freeze(kinds.filter(kind => attempts.get(attemptId).has(kind)));
      return Object.freeze({ attemptId, records, status: attemptStatus(records) });
    })),
    unrecognized: Object.freeze(unrecognized.sort()),
  });
}
