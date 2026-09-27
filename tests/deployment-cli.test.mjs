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
  const options = parseArguments('upgrade', ['--project-dir', project, '--revision', revision]);
  assert.equal(options.project, project);
  assert.equal(options.revision, revision);
  assert.equal(options.operation, 'upgrade');
});

test('recovery argument quoting handles apostrophes in both shells', () => {
  assert.equal(quoteArgument("/srv/owner's chat", 'linux'), "'/srv/owner'\\''s chat'");
  assert.equal(quoteArgument("C:\\owner's chat", 'win32'), "'C:\\owner''s chat'");
  assert.throws(() => quoteArgument('bad\npath', 'linux'), /argument/i);
  assert.throws(() => quoteArgument('path', 'unknown'), /platform/i);
});
