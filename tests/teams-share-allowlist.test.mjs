import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmails, readAllowList, updateAllowList } from '../scripts/teams-share/allowlist.mjs';

test('parseEmails splits, lowercases, and de-duplicates', () => {
  assert.deepEqual(parseEmails(['A@x.com,b@x.com', 'a@X.com;c@x.co.uk']), ['a@x.com', 'b@x.com', 'c@x.co.uk']);
});

test('parseEmails rejects anything a shell could interpret, and empty input', () => {
  for (const bad of ['a@x.com&calc', 'a"@x.com', '%PATH%@x.com', 'nobody', 'a@x']) {
    assert.throws(() => parseEmails([bad]), /Not a valid email/, bad);
  }
  assert.throws(() => parseEmails([' , ']), /at least one/);
});

test('add appends only new addresses and keeps the rest of the file', () => {
  const text = '# top\r\nAUTH=1\r\nTEAMS_ALLOWED_USERS=Me@x.com # owners\r\nZ=2\r\n';
  const r = updateAllowList(text, 'add', ['me@x.com', 'ruim@x.com']);
  assert.deepEqual(r.changed, ['ruim@x.com']);
  assert.equal(r.text, '# top\r\nAUTH=1\r\nTEAMS_ALLOWED_USERS=Me@x.com,ruim@x.com # owners\r\nZ=2\r\n');
});

test('add keeps quotes and an export prefix, and appends the key when missing', () => {
  assert.equal(updateAllowList('export TEAMS_ALLOWED_USERS="a@x.com"\n', 'add', ['b@x.com']).text,
    'export TEAMS_ALLOWED_USERS="a@x.com,b@x.com"\n');
  assert.equal(updateAllowList('A=1\n# TEAMS_ALLOWED_USERS=old@x.com', 'add', ['b@x.com']).text,
    'A=1\n# TEAMS_ALLOWED_USERS=old@x.com\nTEAMS_ALLOWED_USERS=b@x.com\n');
});

test('remove matches case-insensitively and reports no change when absent', () => {
  const r = updateAllowList('TEAMS_ALLOWED_USERS=a@x.com; B@x.com\n', 'remove', ['b@x.com']);
  assert.deepEqual([r.changed, r.list, r.text], [['b@x.com'], ['a@x.com'], 'TEAMS_ALLOWED_USERS=a@x.com\n']);
  const same = 'TEAMS_ALLOWED_USERS=a@x.com\n';
  assert.deepEqual(updateAllowList(same, 'remove', ['z@x.com']), { text: same, changed: [], list: ['a@x.com'] });
});

test('refuses ambiguous files instead of guessing', () => {
  assert.throws(() => readAllowList('TEAMS_ALLOWED_USERS=a@x.com\nTEAMS_ALLOWED_USERS=b@x.com\n'), /set 2 times/);
  assert.throws(() => updateAllowList('TEAMS_ALLOWED_USERS="a@x.com\n', 'add', ['b@x.com']), /unterminated quote/);
});
