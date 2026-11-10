import assert from 'node:assert/strict';
import test from 'node:test';
import { linkWorkItems, normalizeWorkItemUrlTemplate } from '../lib/workItemLinks';

const T = 'https://msdata.visualstudio.com/Messaging%20Connectors/_workitems/edit/{id}';
const url = (id: string) => `https://msdata.visualstudio.com/Messaging%20Connectors/_workitems/edit/${id}`;

test('links bare and #-prefixed IDs, including in tables and lists', () => {
  assert.equal(linkWorkItems('Bug 5809224 and #5614876.', T), `Bug [5809224](${url('5809224')}) and [#5614876](${url('5614876')}).`);
  assert.equal(
    linkWorkItems('| ID | Title |\n|---|---|\n| 5809224 | Fix |', T),
    `| ID | Title |\n|---|---|\n| [5809224](${url('5809224')}) | Fix |`,
  );
  assert.equal(linkWorkItems('- **Feature 5614876**: done', T), `- **Feature [5614876](${url('5614876')})**: done`);
});

test('leaves code, links, URLs, decimals and short or long numbers alone', () => {
  for (const text of [
    'run `az boards 5809224`',
    '```\n5809224\n```',
    '[5809224](https://x.example/1)',
    'see https://x.example/items/5809224 now',
    'size 1234567.89 and 1,234,567',
    'pr 12345 and 123456789',
    'path a/5809224 and id=5809224',
  ]) {
    assert.equal(linkWorkItems(text, T), text);
  }
});

test('requires a valid http(s) template with {id}', () => {
  assert.equal(linkWorkItems('Bug 5809224', ''), 'Bug 5809224');
  assert.equal(linkWorkItems('Bug 5809224', 'javascript:alert({id})'), 'Bug 5809224');
  assert.equal(normalizeWorkItemUrlTemplate(' https://x.example/{id} '), 'https://x.example/{id}');
  assert.equal(normalizeWorkItemUrlTemplate('https://x.example/edit'), '');
  assert.equal(normalizeWorkItemUrlTemplate('ftp://x.example/{id}'), '');
});

test('encodes characters that would break the markdown link', () => {
  assert.equal(linkWorkItems('5809224', 'https://x.example/My Project (A)/{id}'), '[5809224](https://x.example/My%20Project%20%28A%29/5809224)');
});
