import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { scenarios, validateServiceHost } from './service-contract.mjs';
const hosts = [], failures = [];
for (const platform of ['linux', 'win32']) for (const scenario of scenarios) {
  try {
    const host = JSON.parse(await readFile(`service-hosts/${platform}-${scenario}/host.json`, 'utf8'));
    hosts.push(host);
    assert.equal(host.platform, platform); assert.equal(host.scenario, scenario);
    validateServiceHost(host, process.env.GITHUB_RUN_ID, process.env.GITHUB_SHA);
  } catch (error) { failures.push(`${platform}/${scenario}: ${error.message}`); }
}
const rows = hosts.flatMap(host => host.milestones.flatMap(row => row.records));
if (rows.length !== 44 || rows.filter(row => row.phase === 'enabled').length !== 32) {
  failures.push('Expected exactly44 browser records and32 real ASR attempts');
}
const report = { status: failures.length ? 'failed' : 'passed', run: process.env.GITHUB_RUN_ID,
  commit: process.env.GITHUB_SHA, hosts, failures, scope: 'Real service deploy/upgrade voice functional flow; synthetic Git marker upgrades; no quality/physical-device acceptance' };
await mkdir('service-report', { recursive: true });
await writeFile('service-report/summary.json', JSON.stringify(report, null, 2));
await writeFile('service-report/REPORT.md', ['# Real service voice deployment', '', `Status: ${report.status}`,
  report.scope, '', '| Platform/scenario | Milestone | Status |', '| --- | --- | --- |',
  ...hosts.flatMap(host => host.milestones.map(row => `| ${host.platform}/${host.scenario} | ${row.name} | ${row.status} |`)),
  '', '## Failures', ...failures, ''].join('\n'));
console.log(JSON.stringify({ status: report.status, failures }));
if (failures.length) process.exitCode = 1;
