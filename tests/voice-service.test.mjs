import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { milestones, browserPhase, validateServiceHost } from '../scripts/voice/service-contract.mjs';
import { projects, sampleIds, manifestHashes } from '../scripts/voice/lifecycle-contract.ts';

test('service scenarios have fixed milestones and reject missing evidence', () => {
  assert.deepEqual(milestones('fresh-selected'), ['selected', 'keep', 'disabled']);
  assert.deepEqual(milestones('upgrade-enable'), ['initial', 'enabled', 'keep', 'disabled']);
  assert.throws(() => milestones('unknown'));
  assert.throws(() => validateServiceHost({}, 'run', 'commit'));
});
function goodHost(platform, scenario) {
  const host = { platform, scenario, run: 'run', commit: 'commit', status: 'passed', project: '/isolated',
    syntheticUpgrade: true, cleanup: { removed: true, portClosed: true } };
  host.milestones = milestones(scenario).map((name, index) => {
    const phase = browserPhase(name), enabled = phase === 'enabled';
    const capability = { ok: true, enabled, maxSeconds: 30,
      model: enabled ? 'sensevoice-small-q8' : null, provider: enabled ? 'sensevoice-gguf' : null,
      threads: enabled ? 2 : null, resourcePolicy: enabled ? 'standard' : null };
    return { name, status: 'passed', checkout: String(index).repeat(40), expectedCheckout: String(index).repeat(40),
      voiceHash: 'fixed', identity: { manifest: manifestHashes[platform], verifiedRoles: true },
      temporaryRestored: true,
      service: { manager: platform === 'linux' ? 'systemd' : 'scheduled-task', project: host.project,
        active: true, owned: true, pid: index + 1, listenerPid: index + 10, identity: 'account',
        activation: String(index), credentialsAbsent: true },
      records: projects(platform).flatMap(project => (enabled ? sampleIds : [null]).map(sample => ({
        id: `${project}/${phase}${sample ? '/' + sample : ''}`, project, phase, sample,
        status: 'passed', error: null, run: 'run', commit: 'commit', capability,
        sourceSha256: 'a'.repeat(64), delivery: {
          status: 200, body: { ok: true, text: 'Actual transcript', elapsedMs: 1 },
          draft: 'Keep my draft', composer: 'Keep my draft\nActual transcript', sends: 0,
          requestCount: 1, uploadBytes: 100, sourceCompleted: true, tracksStopped: true,
          contextClosed: true, idle: true,
        },
      }))),
    };
  });
  return host;
}
test('complete four-host shape passes; stale or missing service evidence never passes', () => {
  for (const platform of ['linux', 'win32']) for (const scenario of ['fresh-selected', 'upgrade-enable']) {
    const valid = goodHost(platform, scenario);
    validateServiceHost(valid, 'run', 'commit');
    for (const mutate of [
      host => { host.cleanup.removed = false; },
      host => { host.milestones.pop(); },
      host => { host.milestones[0].records.pop(); },
      host => { host.milestones[0].service.owned = false; },
      host => { host.milestones[0].service.credentialsAbsent = false; },
      host => { host.milestones[0].temporaryRestored = false; },
      host => { host.milestones[1].service.activation = host.milestones[0].service.activation; },
      host => { host.milestones.find(row => row.name === 'keep').voiceHash = 'changed'; },
      host => { host.milestones.find(row => row.name === 'keep').checkout = 'f'.repeat(40); },
    ]) {
      const invalid = structuredClone(valid); mutate(invalid);
      assert.throws(() => validateServiceHost(invalid, 'run', 'commit'));
    }
  }
});
test('production task forwards local mode and Linux excludes acquisition tokens', async () => {
  for (const name of ['deploy', 'install-scheduled-task', 'service-watchdog']) {
    assert.match(await readFile(`scripts/${name}.ps1`, 'utf8'), /\[switch\]\$NoTunnel/);
  }
  assert.match(await readFile('scripts/service-watchdog.ps1', 'utf8'), /if \(\$NoTunnel\).*'-NoTunnel'/);
  assert.match(await readFile('scripts/agents-chat.service', 'utf8'), /UnsetEnvironment=GH_TOKEN GITHUB_TOKEN/);
});
