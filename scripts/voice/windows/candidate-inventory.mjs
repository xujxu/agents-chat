import { createHash } from 'node:crypto';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileSha256 } from '../install-package.mjs';
import { models } from '../setup-config.mjs';

const [directory, modelId] = process.argv.slice(2);
if (!directory || !Object.hasOwn(models, modelId)) throw new Error('Expected candidate directory and known model.');
const files = [];
async function walk(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (!/^[a-zA-Z0-9_./-]+$/.test(relative)) throw new Error('Unsupported candidate filename.');
    if (entry.isDirectory()) await walk(path.join(folder, entry.name), relative + '/');
    else if (entry.isFile()) {
      const role = relative === 'bin/voice-job.exe' ? 'helper'
        : relative.startsWith('bin/') ? 'engine'
          : relative.startsWith('models/') ? 'model'
            : relative.startsWith('licenses/') ? 'license' : 'provenance';
      const file = path.join(folder, entry.name);
      const bytes = (await stat(file)).size;
      if (!bytes) throw new Error('Empty candidate file.');
      files.push({ path: relative, role, bytes, sha256: await fileSha256(file) });
    } else throw new Error('Candidate must contain regular files only.');
  }
}
await walk(directory);
for (const role of ['engine', 'helper', 'model']) {
  if (files.filter(file => file.role === role).length !== 1) throw new Error(`Expected exactly one ${role}.`);
}
if (files.find(file => file.role === 'model').sha256 !== models[modelId].modelSha256) {
  throw new Error('Pinned model hash mismatch.');
}
if (!files.some(file => file.role === 'license')) throw new Error('Missing candidate notices.');
const raw = JSON.stringify({
  version: 1, kind: 'windows-native-build-candidate', platform: 'windows-x64', modelId,
  qualification: 'smoke-only-not-release-approved',
  cpuFlags: ['avx2', 'fma', 'f16c', 'bmi2'],
  files: files.sort((a, b) => a.path.localeCompare(b.path)),
}, null, 2) + '\n';
await writeFile(path.join(directory, 'candidate.json'), raw);
await writeFile(path.join(directory, 'candidate.sha256'),
  `${createHash('sha256').update(raw).digest('hex')}  candidate.json\n`);
