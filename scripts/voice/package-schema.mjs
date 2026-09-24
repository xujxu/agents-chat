import { models } from './setup-config.mjs';

export function validateManifest(manifest, model) {
  const windows = manifest?.platform === 'windows-x64';
  const platformValid = windows
    ? manifest.version === 2 && manifest.minWindowsBuild === 19041 && manifest.helperProtocol === 2
      && manifest.utf8Paths === true && manifest.qualification === 'integration-candidate-not-release-approved'
    : manifest?.version === 1 && manifest.platform === 'linux-x64' && manifest.minGlibc === '2.35';
  if (!platformValid || manifest.modelId !== model || !Object.hasOwn(models, model)
    || !Array.isArray(manifest.files) || manifest.files.length < 3 || manifest.files.length > 200
    || JSON.stringify(manifest.cpuFlags) !== JSON.stringify(['avx2', 'fma', 'f16c', 'bmi2'])) {
    throw new Error('Unsupported voice package manifest.');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[0-9a-f]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || !['binary', 'model', 'license', 'provenance', ...(windows ? ['helper'] : [])].includes(file.role)) {
      throw new Error('Invalid package file identity.');
    }
    const key = windows ? file.path.toLowerCase() : file.path;
    if (seen.has(key) || (windows && file.path.split('/').some(part =>
      part.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))) {
      throw new Error('Ambiguous package destination.');
    }
    seen.add(key);
  }
  for (const file of seen) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) throw new Error('Package file conflicts with directory.');
    }
  }
  const binaries = manifest.files.filter(file => file.role === 'binary');
  const weights = manifest.files.filter(file => file.role === 'model');
  const helpers = manifest.files.filter(file => file.role === 'helper');
  if (binaries.length !== 1 || weights.length !== 1
    || weights[0].sha256 !== models[model].modelSha256
    || !manifest.files.some(file => file.role === 'license')
    || (windows && (helpers.length !== 1 || !/\.exe$/i.test(binaries[0].path) || !/\.exe$/i.test(helpers[0].path)))) {
    throw new Error('Incomplete or mismatched model package.');
  }
  const size = manifest.files.reduce((total, file) => total + file.bytes, 0);
  if (!Number.isSafeInteger(size) || size > 2 * 1024 ** 3) throw new Error('Voice package exceeds supported size.');
  return { binary: binaries[0].path, ...(windows ? { helper: helpers[0].path } : {}), model: weights[0].path, size };
}
