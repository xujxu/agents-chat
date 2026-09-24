import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { models } from './setup-config.mjs';

export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function validateManifest(manifest, model) {
  if (manifest.version !== 1 || manifest.modelId !== model || !Object.hasOwn(models, model)
    || manifest.platform !== 'linux-x64' || manifest.minGlibc !== '2.35'
    || !Array.isArray(manifest.files) || manifest.files.length < 3 || manifest.files.length > 200
    || JSON.stringify(manifest.cpuFlags) !== JSON.stringify(['avx2', 'fma', 'f16c', 'bmi2'])) {
    throw new Error('Unsupported voice package manifest.');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || seen.has(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || !['binary', 'model', 'license', 'provenance'].includes(file.role)) throw new Error('Invalid package file identity.');
    seen.add(file.path);
  }
  const binaries = manifest.files.filter(file => file.role === 'binary');
  const weights = manifest.files.filter(file => file.role === 'model');
  if (binaries.length !== 1 || weights.length !== 1
    || weights[0].sha256 !== models[model].modelSha256
    || !manifest.files.some(file => file.role === 'license')) throw new Error('Incomplete or mismatched model package.');
  const size = manifest.files.reduce((total, file) => total + file.bytes, 0);
  if (!Number.isSafeInteger(size) || size > 2 * 1024 ** 3) throw new Error('Voice package exceeds supported size.');
  return { binary: binaries[0].path, model: weights[0].path, size };
}

export async function installVoicePackage({ packageDir, manifestSha256, model, destination, threads, log = console.log }) {
  if (!packageDir || !/^[0-9a-f]{64}$/.test(manifestSha256 ?? '')) {
    throw new Error('Enabling voice requires --package-dir and --manifest-sha256 from a trusted, verified Actions package. No public runtime release is published yet.');
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Native voice packages currently require Linux x86_64.');
  const source = await realpath(packageDir);
  const manifestPath = path.join(source, 'voice-package.json');
  if (!(await lstat(manifestPath)).isFile()) throw new Error('Package manifest must be a regular file.');
  const raw = await readFile(manifestPath);
  if (raw.length > 256 * 1024 || createHash('sha256').update(raw).digest('hex') !== manifestSha256) {
    throw new Error('Voice package manifest checksum mismatch.');
  }
  const manifest = JSON.parse(raw);
  const identity = validateManifest(manifest, model);
  const glibc = process.report.getReport().header.glibcVersionRuntime;
  const version = /^(\d+)\.(\d+)$/.exec(glibc ?? '');
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 35)) {
    throw new Error('This voice package requires glibc 2.35 or newer.');
  }
  const cpu = await readFile('/proc/cpuinfo', 'utf8');
  const flags = [...cpu.matchAll(/^flags\s*:\s*(.*)$/gm)].map(match => new Set(match[1].split(/\s+/)));
  if (!flags.length || flags.some(set => manifest.cpuFlags.some(flag => !set.has(flag)))) {
    throw new Error('CPU lacks required AVX2/FMA/F16C/BMI2 instructions.');
  }
  await access('/usr/bin/nice');
  await access('/usr/bin/prlimit');
  const memory = await readFile('/proc/meminfo', 'utf8');
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(memory);
  if (!available) throw new Error('Cannot determine available memory for installation guidance.');
  log(`Host MemAvailable: ${Math.floor(Number(available[1]) / 1024)} MiB (not reserved; external cgroup limits may be lower).`);
  log(`Model threads: ${threads}. No new CPU/RAM hard quota. Shared hosts require administrator capacity planning.`);
  if (Number(available[1]) < 768 * 1024) log('WARNING: less than 768 MiB host memory available; this is a caution, not a measured model minimum.');
  const space = await statfs(destination);
  if (space.bavail * space.bsize < identity.size + 64 * 1024 ** 2) throw new Error('Insufficient disk space to stage the voice package.');
  const installed = path.join(destination, 'packages', manifestSha256);
  await mkdir(path.dirname(installed), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(path.join(destination, 'package-stage-'));
  try {
    for (const file of manifest.files) {
      const from = path.join(source, file.path);
      const actual = await realpath(from);
      if (!actual.startsWith(source + path.sep) || !(await lstat(from)).isFile()) throw new Error('Package files must be regular files inside the package.');
      const to = path.join(stage, file.path);
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await copyFile(from, to);
      if ((await lstat(to)).size !== file.bytes || await fileSha256(to) !== file.sha256) throw new Error('Voice package file checksum mismatch.');
      await chmod(to, file.role === 'binary' ? 0o755 : 0o644);
    }
    try { await rename(stage, installed); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      for (const file of manifest.files) {
        const target = path.join(installed, file.path);
        if (!(await lstat(target)).isFile() || await fileSha256(target) !== file.sha256) throw new Error('Previously installed package was modified.');
      }
    }
    return { binary: path.join(installed, identity.binary), model: path.join(installed, identity.model), threads };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
