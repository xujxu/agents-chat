import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateManifest } from '../scripts/voice/install-package.mjs';
import { models } from '../scripts/voice/setup-config.mjs';

const model = 'sensevoice-small-q8';
const manifest = {
  version: 2, platform: 'windows-x64', minWindowsBuild: 19041, helperProtocol: 2, utf8Paths: true,
  qualification: 'integration-candidate-not-release-approved', modelId: model,
  cpuFlags: ['avx2', 'fma', 'f16c', 'bmi2'],
  files: [
    { path: 'bin/engine.exe', role: 'binary', sha256: 'a'.repeat(64), bytes: 10 },
    { path: 'bin/voice-job.exe', role: 'helper', sha256: 'b'.repeat(64), bytes: 10 },
    { path: 'models/model', role: 'model', sha256: models[model].modelSha256, bytes: 100 },
    { path: 'licenses/notice.txt', role: 'license', sha256: 'c'.repeat(64), bytes: 10 },
  ],
};

test('Windows schema identifies helper and rejects ambiguous Windows destinations', () => {
  assert.deepEqual(validateManifest(manifest, model), {
    binary: 'bin/engine.exe', helper: 'bin/voice-job.exe', model: 'models/model', size: 130,
  });
  for (const relative of [
    '../escape', '/absolute', 'C:/engine.exe', 'bin/file:stream', 'bin/CON.txt',
    'bin/nul.exe', 'bin/COM1.exe', 'bin/LPT9', 'bin/engine.', 'bin//engine',
    'bin/./engine', 'bin/../engine', 'bin/engine.exe/child',
  ]) {
    const candidate = structuredClone(manifest);
    candidate.files.push({ path: relative, role: 'provenance', sha256: 'd'.repeat(64), bytes: 1 });
    assert.throws(() => validateManifest(candidate, model), relative);
  }
  for (const change of [
    { version: 1 }, { minWindowsBuild: 0 }, { helperProtocol: 1 }, { utf8Paths: false },
    { qualification: 'release-approved' },
    { files: manifest.files.filter(file => file.role !== 'helper') },
    { files: [...manifest.files, { ...manifest.files[0], path: 'BIN/ENGINE.exe' }] },
    { files: [...manifest.files, { ...manifest.files[1], path: 'bin/other-helper.exe' }] },
    { files: manifest.files.map(file => file.role === 'binary' ? { ...file, path: 'bin/engine.cmd' } : file) },
    { files: manifest.files.map(file => file.role === 'model' ? { ...file, sha256: '0'.repeat(64) } : file) },
  ]) assert.throws(() => validateManifest({ ...manifest, ...change }, model));
});

test('Windows host compatibility fails closed and does not pretend Job quotas are known', async () => {
  const { validateWindowsHost } = await import('../scripts/voice/windows/import-package.mjs');
  const host = {
    version: 1, windowsBuild: 20348, cpuFlags: ['avx2', 'fma', 'f16c', 'bmi2'],
    availablePhysicalBytes: 2 * 1024 ** 3, totalPhysicalBytes: 8 * 1024 ** 3,
    logicalCpus: 4, affinityLogicalCpus: 4, inJob: true, jobLimitsKnown: false,
  };
  assert.deepEqual(validateWindowsHost(host, manifest), host);
  for (const change of [
    { cpuFlags: ['avx2', 'fma', 'f16c'] }, { cpuFlags: [] }, { windowsBuild: 18362 },
    { availablePhysicalBytes: -1 }, { availablePhysicalBytes: NaN },
    { availablePhysicalBytes: 9 * 1024 ** 3 }, { totalPhysicalBytes: 0 },
    { logicalCpus: 0 }, { affinityLogicalCpus: 5 }, { inJob: 'unknown' },
    { jobLimitsKnown: true }, { version: 2 },
  ]) assert.throws(() => validateWindowsHost({ ...host, ...change }, manifest));
});
