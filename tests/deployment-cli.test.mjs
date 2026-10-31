import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments, quoteArgument } from '../scripts/deployment/cli.mjs';

test('deployment defaults neither preselect a revision nor skip backup', () => {
  const options = parseArguments('deploy', []);
  assert.equal(options.operation, 'deploy');
  assert.equal(options.noPull, false);
  assert.equal(options.waitSeconds, 120);
  assert.equal(options.revision, undefined);
});

for (const args of [
  ['--skip-backup'], ['--wait', '-1'], ['--wait', 'NaN'],
  ['--wait', '1.5'], ['--wait'], ['--revision'],
  ['--revision', 'a'.repeat(40), '--no-pull'],
  ['--status', '--verify'], ['--status', '--revision', 'a'.repeat(40)],
  ['--revision', '--help'], ['--wait', '0', '--wait', '20'],
]) {
  test(`invalid or conflicting flags reject before execution: ${args.join(' ')}`, () => {
    assert.throws(() => parseArguments('deploy', args), /argument|option|wait|revision|conflict|duplicate/i);
  });
}

test('unattended restoration requires an explicit data-loss acknowledgement', () => {
  assert.equal(parseArguments('restore', []).acceptDataLoss, false);
  assert.equal(parseArguments('restore', ['--accept-data-loss']).acceptDataLoss, true);
  assert.throws(() => parseArguments('deploy', ['--accept-data-loss']), /restore|option/i);
  assert.throws(() => parseArguments('restore', ['--revision', 'a'.repeat(40)]), /restore|option/i);
});

test('status and verify are distinct operations', () => {
  assert.equal(parseArguments('deploy', ['--status']).operation, 'status');
  assert.equal(parseArguments('deploy', ['--verify']).operation, 'verify');
  assert.equal(parseArguments('deploy', ['--wait', '0']).waitSeconds, 0);
});

test('revision and paths with spaces remain exact data', () => {
  const revision = 'a'.repeat(40);
  const project = 'C:\\Apps\\Chat project';
  const options = parseArguments('update', ['--project-dir', project, '--revision', revision]);
  assert.equal(options.project, project);
  assert.equal(options.revision, revision);
  assert.equal(options.operation, 'update');
});

test('update replaces the unpublished upgrade operation without an alias', () => {
  assert.equal(parseArguments('update', []).operation, 'update');
  assert.throws(() => parseArguments('upgrade', []), /operation/i);
});

test('preview, JSON and stage deadline are explicit options', () => {
  const defaults = parseArguments('update', []);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.json, false);
  assert.equal(defaults.timeoutSeconds, 1800);
  const options = parseArguments('update', ['--dry-run', '--json', '--timeout', '90']);
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
  assert.equal(options.timeoutSeconds, 90);
  assert.equal(options.waitSeconds, 120);
  assert.equal(parseArguments('deploy', ['--dry-run']).dryRun, true);
});

test('JSON is supported for status, verification and restore', () => {
  for (const [operation, args, expected] of [
    ['update', ['--status', '--json'], 'status'],
    ['update', ['--verify', '--json', '--timeout', '60'], 'verify'],
    ['restore', ['--accept-data-loss', '--json', '--timeout', '60'], 'restore'],
  ]) {
    const options = parseArguments(operation, args);
    assert.equal(options.json, true);
    assert.equal(options.operation, expected);
  }
});

test('deadlines and read-only mode conflicts reject before execution', () => {
  for (const args of [
    ['--timeout', '0'], ['--timeout', '-1'], ['--timeout', '1.5'],
    ['--timeout', '9007199254740992'], ['--timeout', 'Infinity'],
    ['--timeout'], ['--timeout', '1', '--timeout', '2'],
    ['--dry-run', '--status'], ['--dry-run', '--verify'],
    ['--json', '--json'], ['--status', '--timeout', '10'],
  ]) assert.throws(() => parseArguments('update', args), /option|timeout|argument|duplicate|conflict/i);
  assert.throws(() => parseArguments('restore', ['--dry-run']), /restore|option/i);
});

test('recovery argument quoting handles apostrophes in both shells', () => {
  assert.equal(quoteArgument("/srv/owner's chat", 'linux'), "'/srv/owner'\\''s chat'");
  assert.equal(quoteArgument("C:\\owner's chat", 'win32'), "'C:\\owner''s chat'");
  assert.throws(() => quoteArgument('bad\npath', 'linux'), /argument/i);
  assert.throws(() => quoteArgument('path', 'unknown'), /platform/i);
});
