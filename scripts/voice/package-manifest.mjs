import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileSha256, validateManifest } from './install-package.mjs';

const [directory, modelId] = process.argv.slice(2);
if (!directory || !modelId) throw new Error('Usage: package-manifest.mjs DIRECTORY MODEL');
const files = [];
async function walk(folder, prefix = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await walk(path.join(folder, entry.name), relative + '/');
    else if (entry.isFile()) {
      const role = relative.startsWith('bin/') ? 'binary' : relative.startsWith('models/') ? 'model'
        : relative.startsWith('licenses/') ? 'license' : 'provenance';
      files.push({ path: relative, role, bytes: (await stat(path.join(folder, entry.name))).size,
        sha256: await fileSha256(path.join(folder, entry.name)) });
    } else throw new Error('Unexpected non-regular runtime package file.');
  }
}
await walk(directory);
const manifest = {
  version: 1, modelId, platform: 'linux-x64', minGlibc: '2.35',
  cpuFlags: ['avx2', 'fma', 'f16c', 'bmi2'],
  qualification: 'integration-candidate-not-release-approved',
  files: files.sort((a, b) => a.path.localeCompare(b.path)),
};
validateManifest(manifest, modelId);
const file = path.join(directory, 'voice-package.json');
await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(directory, 'voice-package.sha256'),
  `${createHash('sha256').update(await readFile(file)).digest('hex')}  voice-package.json\n`);
