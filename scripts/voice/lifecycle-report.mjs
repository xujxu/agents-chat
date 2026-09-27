import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { validateHost, sampleIds } from './lifecycle-contract.ts';
import { catalogue } from './download-catalog.mjs';
import assert from 'node:assert/strict';
const experimental = process.env.VOICE_LIFECYCLE_DOWNLOAD === 'true';
const [input = 'lifecycle-hosts', output = 'lifecycle-report'] = process.argv.slice(2);
const hosts = [], failures = [];
for (const platform of ['linux', 'win32']) {
  try {
    const host = JSON.parse(await readFile(`${input}/${platform}/host.json`, 'utf8'));
    hosts.push(host);
    if (host.platform !== platform) throw new Error('Host identity mismatch');
    validateHost(host, process.env.GITHUB_RUN_ID, process.env.GITHUB_SHA);
    if (experimental) {
      assert.equal(host.acquisition?.mode, 'experimental-download');
      assert.equal(host.acquisition?.verified, true);
      assert.deepEqual(host.acquisition?.catalogue, catalogue[platform]);
    }
  } catch (error) { failures.push(`${platform}: ${error instanceof Error ? error.message : String(error)}`); }
}
for (const id of sampleIds) {
  const hashes = hosts.flatMap(host => host.records.filter(row => row.sample === id).map(row => row.sourceSha256));
  if (hashes.length !== 4 || new Set(hashes).size !== 1) failures.push(`${id}: missing or mismatched source identity`);
}
const summary = { status: failures.length ? 'failed' : 'passed', run: process.env.GITHUB_RUN_ID,
  commit: process.env.GITHUB_SHA, failures, hosts: hosts.map(host => ({
    platform: host.platform, status: host.status, phases: host.phases, identity: host.identity,
    environment: host.environment, records: host.records, acquisition: host.acquisition,
  })), scope: 'Functional installation/enable/real-ASR-draft/disable; no accuracy or latency qualification',
  limits: 'Hosted Linux/Windows Server; mobile emulation, not physical devices/Win11; candidate packages; unrelated chat fixtures' };
await mkdir(output, { recursive: true });
await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2));
const lines = ['# Installed voice lifecycle E2E', '', `Status: ${summary.status}`, summary.scope, summary.limits, '',
  `Acquisition: ${experimental ? 'explicit experimental Actions download by real CLI' : 'explicit offline package'}`, '',
  '| Host | Phase | Status |', '| --- | --- | --- |'];
for (const host of hosts) for (const phase of host.phases) lines.push(`| ${host.platform} | ${phase.name} | ${phase.status} |`);
lines.push('', '| Browser record | Status |', '| --- | --- |');
for (const host of hosts) for (const row of host.records) lines.push(`| ${row.id} | ${row.status} |`);
lines.push('', '## Failures', ...failures);
await writeFile(`${output}/REPORT.md`, lines.join('\n') + '\n');
console.log(JSON.stringify({ status: summary.status, failures }));
if (failures.length) process.exitCode = 1;
