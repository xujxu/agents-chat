import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { milestones, validateServiceHost } from '../scripts/voice/service-contract.mjs';

test('service scenarios have fixed milestones and reject missing evidence', () => {
  assert.deepEqual(milestones('fresh-selected'), ['selected', 'keep', 'disabled']);
  assert.deepEqual(milestones('upgrade-enable'), ['initial', 'enabled', 'keep', 'disabled']);
  assert.throws(() => milestones('unknown'));
  assert.throws(() => validateServiceHost({}, 'run', 'commit'));
});
test('production task forwards local mode and Linux excludes acquisition tokens', async () => {
  for (const name of ['deploy', 'install-scheduled-task', 'service-watchdog']) {
    assert.match(await readFile(`scripts/${name}.ps1`, 'utf8'), /\[switch\]\$NoTunnel/);
  }
  assert.match(await readFile('scripts/service-watchdog.ps1', 'utf8'), /if \(\$NoTunnel\).*'-NoTunnel'/);
  assert.match(await readFile('scripts/agents-chat.service', 'utf8'), /UnsetEnvironment=GH_TOKEN GITHUB_TOKEN/);
});
