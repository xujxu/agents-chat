import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { release } from 'node:os';
import { promisify } from 'node:util';
import { fileSha256 } from '../install-package.mjs';
import { validateManifest } from '../package-schema.mjs';

const execute = promisify(execFile);

export function validateWindowsHost(info, manifest) {
  if (!info || info.version !== 1 || !Number.isInteger(info.windowsBuild)
    || info.windowsBuild < manifest.minWindowsBuild || !Array.isArray(info.cpuFlags)
    || manifest.cpuFlags.some(flag => !info.cpuFlags.includes(flag))) {
    throw new Error('Windows build or CPU/OS instruction support does not meet package requirements.');
  }
  if (![info.availablePhysicalBytes, info.totalPhysicalBytes, info.logicalCpus, info.affinityLogicalCpus]
    .every(value => Number.isSafeInteger(value) && value >= 0)
    || info.totalPhysicalBytes === 0 || info.availablePhysicalBytes > info.totalPhysicalBytes
    || info.logicalCpus < 1 || info.affinityLogicalCpus < 1 || info.affinityLogicalCpus > info.logicalCpus
    || typeof info.inJob !== 'boolean' || info.jobLimitsKnown !== false) {
    throw new Error('Invalid Windows resource observation.');
  }
  return info;
}

async function regularFile(root, relative) {
  let file = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    file = path.join(file, parts[i]);
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || (i < parts.length - 1 ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) {
      throw new Error('Package paths must be ordinary unlinked files/directories.');
    }
  }
  const resolved = await realpath(file);
  const inside = path.relative(root, resolved);
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Package path escapes its root.');
  return file;
}

async function verifyFiles(root, manifest) {
  for (const file of manifest.files) {
    const target = await regularFile(root, file.path);
    if ((await lstat(target)).size !== file.bytes || await fileSha256(target) !== file.sha256) {
      throw new Error('Voice package file checksum mismatch.');
    }
  }
}

export async function importWindowsVoicePackage({
  packageDir, manifestSha256, model, destination, threads, log = console.log,
}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows package import requires native Windows x64.');
  if (!packageDir || !/^[0-9a-f]{64}$/.test(manifestSha256 ?? '') || ![1, 2, 4].includes(threads)) {
    throw new Error('Trusted manifest SHA256, package directory and supported thread count are required.');
  }
  if (!(await lstat(packageDir)).isDirectory()) throw new Error('Package root must be an ordinary directory.');
  const source = await realpath(packageDir);
  const manifestFile = await regularFile(source, 'voice-package.json');
  const handle = await open(manifestFile, 'r');
  let raw;
  try {
    if ((await handle.stat()).size > 256 * 1024) throw new Error('Package manifest too large.');
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 256 * 1024) throw new Error('Package manifest too large.');
    raw = buffer.subarray(0, length);
  } finally { await handle.close(); }
  if (createHash('sha256').update(raw).digest('hex') !== manifestSha256) throw new Error('Voice package manifest checksum mismatch.');
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.platform !== 'windows-x64') throw new Error('Package does not match Windows x64.');
  const identity = validateManifest(manifest, model);
  if (Number(release().split('.')[2]) < manifest.minWindowsBuild) throw new Error('Windows build is below the package minimum.');
  if (!(await lstat(destination)).isDirectory()) throw new Error('Destination must be an ordinary directory.');
  const targetRoot = await realpath(destination);
  const space = await statfs(targetRoot);
  if (space.bavail * space.bsize < identity.size + 64 * 1024 ** 2) throw new Error('Insufficient staging disk space.');
  const stage = await mkdtemp(path.join(targetRoot, 'package-stage-'));
  try {
    for (const file of manifest.files) {
      const from = await regularFile(source, file.path);
      if ((await lstat(from)).size !== file.bytes) throw new Error('Voice package file checksum mismatch.');
      const to = path.join(stage, file.path);
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    }
    await verifyFiles(stage, manifest);
    const root = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
    if (!root || !path.isAbsolute(root)) throw new Error('Windows SystemRoot is unavailable.');
    const { stdout } = await execute(path.join(stage, identity.helper), ['--inspect-host'], {
      windowsHide: true, timeout: 10000, maxBuffer: 16384, encoding: 'utf8',
      env: { SystemRoot: root, WINDIR: root, PATH: `${path.join(root, 'System32')};${root}`, TEMP: stage, TMP: stage },
    });
    const info = validateWindowsHost(JSON.parse(stdout), manifest);
    log(`Windows build ${info.windowsBuild}; CPU and OS state support required AVX2/FMA/F16C/BMI2.`);
    log(`Available physical memory: ${Math.floor(info.availablePhysicalBytes / 1024 ** 2)} MiB of ${Math.floor(info.totalPhysicalBytes / 1024 ** 2)} MiB; not reserved.`);
    log(`Host logical CPUs: ${info.logicalCpus}; installer current-group affinity: ${info.affinityLogicalCpus}.`);
    log(`Installer in a Job: ${info.inJob}. Effective nested Job CPU/memory limits are not known; check the target service's deployment policy.`);
    log(`Model threads: ${threads}. No new CPU/RAM hard quota. Installer observations do not guarantee target-service capacity.`);
    if (info.availablePhysicalBytes < 768 * 1024 ** 2) log('WARNING: low available physical memory; 768 MiB is cautionary, not a measured Windows model minimum.');
    await writeFile(path.join(stage, 'voice-package.json'), raw, { flag: 'wx' });
    const packages = path.join(targetRoot, 'packages');
    await mkdir(packages, { recursive: true });
    if (!(await lstat(packages)).isDirectory() || (await realpath(packages)).toLowerCase() !== packages.toLowerCase()) {
      throw new Error('Installed packages directory must not redirect elsewhere.');
    }
    const installed = path.join(packages, manifestSha256);
    async function verifyInstalled() {
      if (!(await lstat(installed)).isDirectory()) throw new Error('Installed package root is not an ordinary directory.');
      const saved = await regularFile(installed, 'voice-package.json');
      if (!(await readFile(saved)).equals(raw)) throw new Error('Previously installed manifest was modified.');
      await verifyFiles(installed, manifest);
    }
    let exists = true;
    try { await lstat(installed); }
    catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    if (exists) await verifyInstalled();
    else {
      try { await rename(stage, installed); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        await verifyInstalled();
      }
    }
    return { binary: path.join(installed, identity.binary), launcher: path.join(installed, identity.helper),
      model: path.join(installed, identity.model), threads };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
