import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileSha256, validateManifest } from './install-package.mjs';

const [directory, modelId, platform = 'linux-x64'] = process.argv.slice(2);
if (!directory || !modelId) throw new Error('Usage: package-manifest.mjs DIRECTORY MODEL');
if (!['linux-x64', 'windows-x64'].includes(platform)) throw new Error('Unsupported manifest platform.');
const windows = platform === 'windows-x64';
const files = [];
async function walk(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (['candidate.json', 'candidate.sha256', 'voice-package.json', 'voice-package.sha256'].includes(relative)) continue;
    if (entry.isDirectory()) await walk(path.join(folder, entry.name), relative + '/');
    else if (entry.isFile()) {
      const role = windows && relative === 'bin/voice-job.exe' ? 'helper'
        : relative.startsWith('bin/') ? 'binary' : relative.startsWith('models/') ? 'model'
        : relative.startsWith('licenses/') ? 'license' : 'provenance';
      files.push({ path: relative, role, bytes: (await stat(path.join(folder, entry.name))).size,
        sha256: await fileSha256(path.join(folder, entry.name)) });
    } else throw new Error('Unexpected non-regular runtime package file.');
  }
}
await walk(directory);
const manifest = {
  ...(windows ? { version: 2, minWindowsBuild: 19041, helperProtocol: 2, utf8Paths: true }
    : { version: 1, minGlibc: '2.35' }),
  modelId, platform,
  cpuFlags: ['avx2', 'fma', 'f16c', 'bmi2'],
  qualification: 'integration-candidate-not-release-approved',
  files: files.sort((a, b) => a.path.localeCompare(b.path)),
};
validateManifest(manifest, modelId);
const file = path.join(directory, 'voice-package.json');
await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(directory, 'voice-package.sha256'),
  `${createHash('sha256').update(await readFile(file)).digest('hex')}  voice-package.json\n`);
