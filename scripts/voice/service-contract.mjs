import assert from 'node:assert/strict';
import { assertCapability, assertDelivery, projects, sampleIds, manifestHashes } from './lifecycle-contract.ts';
export const scenarios = ['fresh-selected', 'upgrade-enable'];
export function milestones(scenario) {
  assert.ok(scenarios.includes(scenario), 'Unknown service scenario');
  return scenario === 'fresh-selected' ? ['selected', 'keep', 'disabled'] : ['initial', 'enabled', 'keep', 'disabled'];
}
export function browserPhase(name) {
  return ['selected', 'enabled', 'keep'].includes(name) ? 'enabled' : name;
}
export function validateServiceHost(host, run, commit) {
  assert.equal(host.run, run); assert.equal(host.commit, commit);
  assert.equal(host.status, 'passed');
  const names = milestones(host.scenario);
  const browsers = projects(host.platform);
  assert.equal(host.cleanup?.removed, true);
  assert.equal(host.cleanup?.portClosed, true);
  assert.equal(host.syntheticUpgrade, true);
  assert.deepEqual(host.milestones.map(row => row.name), names);
  let prior, lastEnabled;
  for (const row of host.milestones) {
    assert.equal(row.status, 'passed');
    const service = row.service;
    assert.equal(service.manager, host.platform === 'linux' ? 'systemd' : 'scheduled-task');
    assert.equal(service.project, host.project);
    assert.equal(service.active, true); assert.equal(service.owned, true);
    assert.equal(service.credentialsAbsent, true);
    assert.ok(Number.isInteger(service.pid) && service.pid > 0);
    assert.ok(Number.isInteger(service.listenerPid) && service.listenerPid > 0);
    assert.ok(service.identity && service.activation);
    assert.equal(row.temporaryRestored, true);
    assert.match(row.checkout, /^[0-9a-f]{40}$/);
    if (prior) {
      assert.notEqual(service.activation, prior.service.activation);
      assert.equal(service.identity, prior.service.identity);
    }
    if (row.name === 'keep' || row.name === 'enabled') {
      assert.equal(row.checkout, row.expectedCheckout);
      assert.notEqual(row.checkout, prior.checkout);
    }
    const phase = browserPhase(row.name);
    if (phase === 'enabled') {
      assert.equal(row.identity.manifest, manifestHashes[host.platform]);
      assert.equal(row.identity.verifiedRoles, true);
      if (row.name === 'keep') {
        assert.deepEqual(row.identity, lastEnabled.identity);
        assert.equal(row.voiceHash, lastEnabled.voiceHash);
      }
      lastEnabled = row;
    }
    assert.ok(Array.isArray(row.records));
    const expected = browsers.flatMap(project => phase === 'enabled'
      ? sampleIds.map(id => `${project}/${phase}/${id}`) : [`${project}/${phase}`]);
    assert.deepEqual(row.records.map(record => record.id).sort(), expected.sort());
    for (const record of row.records) {
      assert.equal(record.run, run); assert.equal(record.commit, commit);
      assert.equal(record.status, 'passed'); assert.equal(record.error, null);
      assert.equal(record.phase, phase);
      assert.ok(browsers.includes(record.project));
      assert.equal(record.id, `${record.project}/${phase}${phase === 'enabled' ? `/${record.sample}` : ''}`);
      assertCapability(record.capability, phase === 'enabled');
      if (phase === 'enabled') {
        assert.ok(sampleIds.includes(record.sample));
        assertDelivery(record.delivery);
        assert.match(record.sourceSha256, /^[0-9a-f]{64}$/);
      } else assert.equal(record.sample, null);
    }
    prior = row;
  }
}
