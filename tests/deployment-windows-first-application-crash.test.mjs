import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { crashWindowsFirstApplication } from './deployment-windows-first-application-crash.mjs';

test('first application crash observer ignores the mutable deployment journal', { timeout: 10000 }, async t => {
  const control = await temporaryDeployment(t);
  await writeFile(path.join(control, 'state.json'), 'not an observer input\n');
  await assert.rejects(crashWindowsFirstApplication({
    args: ['--eval', "process.stderr.write('FIXTURE_ACTOR_EXIT'); setTimeout(() => process.exit(1), 100);"],
    control, taskName: 'Crash-Observer-Fixture', operationId: randomUUID(),
  }), /Actual first actor exited before its crash boundary: FIXTURE_ACTOR_EXIT/);
});
