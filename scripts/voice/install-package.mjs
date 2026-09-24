import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { validateManifest } from './package-schema.mjs';
export { validateManifest } from './package-schema.mjs';

export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
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
  if (manifest.platform !== 'linux-x64') throw new Error('Package does not match the Linux installer platform.');
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
  log(`Installer CPU affinity exposes ${availableParallelism()} logical CPUs; this is not a dedicated CPU reservation.`);
  for (const name of ['cpu.max', 'memory.max', 'memory.current']) {
    try { log(`Visible cgroup ${name}: ${(await readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim()}`); }
    catch (error) {
      if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
      log(`Visible cgroup ${name}: unavailable; deployment-specific limits must be checked by the administrator.`);
    }
  }
  log('These observations describe the installer environment, not a guarantee about a separately configured application service.');
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
    await writeFile(path.join(stage, 'voice-package.json'), raw, { mode: 0o644 });
    try { await rename(stage, installed); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      for (const file of manifest.files) {
        const target = path.join(installed, file.path);
        if (!(await realpath(target)).startsWith(installed + path.sep)
          || !(await lstat(target)).isFile() || await fileSha256(target) !== file.sha256) throw new Error('Previously installed package was modified.');
      }
    }
    return { binary: path.join(installed, identity.binary), model: path.join(installed, identity.model), threads };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
