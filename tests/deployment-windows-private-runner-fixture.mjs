import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

test('private Windows runner diagnostic fixture', async () => {
  process.stdout.write('PRIVATE_RUNNER_STDOUT\n');
  process.stderr.write('PRIVATE_RUNNER_STDERR\n');
  switch (process.env.DEPLOYMENT_TEST_PRIVATE_RUNNER_SCENARIO) {
    case 'failure':
      assert.fail('PRIVATE_RUNNER_EXPECTED_FAILURE');
      break;
    case 'timeout':
      await setTimeout(60_000);
      break;
    default:
      throw new Error('Private runner fixture requires an explicit scenario.');
  }
});
