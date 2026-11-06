// Pure helpers for editing TEAMS_ALLOWED_USERS in .env.local (no I/O, unit-tested).

export const KEY = 'TEAMS_ALLOWED_USERS';

// Strict on purpose: the addresses are passed to the atk CLI through a shell on Windows.
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export class UsageError extends Error {}

export function parseEmails(args) {
  const emails = [];
  for (const raw of args.flatMap((a) => a.split(/[,;\s]+/)).filter(Boolean)) {
    if (!EMAIL.test(raw)) throw new UsageError(`Not a valid email address: ${raw}`);
    const email = raw.toLowerCase();
    if (!emails.includes(email)) emails.push(email);
  }
  if (!emails.length) throw new UsageError('Give at least one email address.');
  return emails;
}

const LINE = new RegExp(`^(\\s*(?:export\\s+)?${KEY}\\s*=\\s*)(.*)$`);
const split = (value) => value.split(/[,;\s]+/).filter(Boolean);

// Split a dotenv value into its text and any trailing comment, honouring quotes.
function splitValue(rest) {
  const q = rest[0];
  if (q === '"' || q === "'") {
    const end = rest.indexOf(q, 1);
    if (end === -1) throw new Error(`${KEY} has an unterminated quote in .env.local; fix it by hand.`);
    return { value: rest.slice(1, end), tail: rest.slice(end + 1), quote: q };
  }
  const m = rest.match(/^(.*?)(\s+#.*)?$/);
  return { value: m[1], tail: m[2] ?? '', quote: '' };
}

function locate(lines) {
  const idx = lines.map((l, i) => (LINE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (idx.length > 1) throw new Error(`${KEY} is set ${idx.length} times in .env.local; keep one line and retry.`);
  if (!idx.length) return null;
  const [, prefix, rest] = lines[idx[0]].match(LINE);
  return { index: idx[0], prefix, ...splitValue(rest) };
}

export function readAllowList(text) {
  const found = locate(text.split(/\r?\n/));
  return found ? split(found.value) : [];
}

// Returns the new file text, the addresses that actually changed, and the resulting list.
// Keeps other lines, the line ending, quotes, comments, and existing entries' spelling.
export function updateAllowList(text, op, emails) {
  if (op !== 'add' && op !== 'remove') throw new Error(`Unknown operation ${op}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const found = locate(lines);
  const current = found ? split(found.value) : [];
  const has = (e) => current.some((c) => c.toLowerCase() === e);

  const changed = op === 'add' ? emails.filter((e) => !has(e)) : emails.filter(has);
  if (!changed.length) return { text, changed, list: current };
  const list = op === 'add'
    ? [...current, ...changed]
    : current.filter((c) => !emails.includes(c.toLowerCase()));

  if (found) {
    lines[found.index] = `${found.prefix}${found.quote}${list.join(',')}${found.quote}${found.tail}`;
  } else {
    if (lines[lines.length - 1] === '') lines.pop();
    lines.push(`${KEY}=${list.join(',')}`, '');
  }
  return { text: lines.join(eol), changed, list };
}
