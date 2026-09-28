import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { authenticationEnvironmentNames, inspectConfigurationCompatibility } from './configuration-compatibility.mjs';
import { realDirectory } from './snapshot-files.mjs';

const dotenvNames = ['.env.production.local', '.env.local', '.env.production', '.env'];
const maxBytes = 1024 * 1024;
const identity = info => ({
  dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, nlink: info.nlink,
  uid: info.uid, gid: info.gid, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs,
});
function refusal(check) {
  return Object.assign(new Error(`Configuration compatibility refused: ${check}.`), {
    code: 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED', check,
    nextAction: 'Inspect the runtime configuration source and supported assignment syntax without printing secret values.',
  });
}

async function optionalStat(file) {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function observe(file, optional) {
  const initial = await optionalStat(file);
  if (!initial) {
    if (!optional) throw refusal('required-configuration-file');
    return null;
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n || initial.size > BigInt(maxBytes)
    || await realpath(path.dirname(file)) !== path.dirname(file)) throw refusal('configuration-file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const original = identity(initial);
    if (!same(identity(await handle.stat({ bigint: true })), original)) throw refusal('configuration-changed');
    const bytes = Buffer.alloc(Number(initial.size) + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await optionalStat(file);
    if (total !== Number(initial.size) || !after || !same(identity(after), original)
      || !same(identity(await handle.stat({ bigint: true })), original)) throw refusal('configuration-changed');
    return { identity: original, bytes: bytes.subarray(0, total) };
  } finally { await handle.close(); }
}

function assignments(bytes, kind) {
  const result = Object.create(null);
  if (kind === 'systemd' && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw refusal('configuration-syntax');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\0\r]/.test(text.replaceAll('\r\n', '\n'))) throw refusal('configuration-syntax');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) throw refusal('configuration-syntax');
    let value = match[2];
    if (/[$\\`]/.test(value)) throw refusal('configuration-syntax');
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length < 2 || value.at(-1) !== quote || value.slice(1, -1).includes(quote)) {
        throw refusal('configuration-syntax');
      }
      value = value.slice(1, -1);
    } else if (/[\s#'"]/.test(value)) throw refusal('configuration-syntax');
    result[match[1]] = value;
  }
  return result;
}

function copyEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || Reflect.ownKeys(environment).length > 4096) throw refusal('environment');
  const result = Object.create(null);
  let bytes = 0;
  for (const name of Reflect.ownKeys(environment)) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, name);
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
      || /[\0\r\n]/.test(descriptor.value)) throw refusal('environment');
    bytes += Buffer.byteLength(name) + Buffer.byteLength(descriptor.value);
    if (bytes > maxBytes) throw refusal('environment-budget');
    result[name] = descriptor.value;
  }
  return result;
}

export async function inspectConfigurationFiles({
  project, profile, environment, systemdFiles = [], observedEnvironment, signal,
}) {
  try {
    signal?.throwIfAborted();
    const root = await realDirectory(project);
    const rootIdentity = identity(await lstat(root, { bigint: true }));
    const effective = copyEnvironment(environment);
    const observedRuntime = observedEnvironment === undefined ? null : copyEnvironment(observedEnvironment);
    const checkRuntime = () => {
      if (effective.__NEXT_PROCESSED_ENV || effective.NODE_ENV && effective.NODE_ENV !== 'production') {
        throw refusal('runtime-environment-policy');
      }
      if (observedRuntime && [...new Set([
        ...authenticationEnvironmentNames, '__NEXT_PROCESSED_ENV', ...Object.keys(effective),
      ])]
        .some(name => effective[name] !== observedRuntime[name])) throw refusal('runtime-environment-changed');
    };
    if (!Array.isArray(systemdFiles) || systemdFiles.length > 32 || systemdFiles.some(file =>
      !file || typeof file.path !== 'string' || !path.isAbsolute(file.path)
      || path.resolve(file.path) !== file.path || /[\0\r\n]/.test(file.path)
      || typeof file.optional !== 'boolean')) throw refusal('configuration-sources');
    const sources = [
      ...systemdFiles.map(file => ({ path: file.path, optional: file.optional, kind: 'systemd' })),
      ...dotenvNames.map(name => ({ path: path.join(root, name), optional: true, kind: 'dotenv' })),
    ];
    const retained = [];
    let checkedRuntime = false;
    for (const source of sources) {
      signal?.throwIfAborted();
      if (source.kind === 'dotenv' && !checkedRuntime) {
        checkRuntime();
        checkedRuntime = true;
      }
      const observed = await observe(source.path, source.optional);
      retained.push({ source, observed });
      if (!observed) continue;
      for (const [name, value] of Object.entries(assignments(observed.bytes, source.kind))) {
        if (source.kind === 'systemd' || !Object.hasOwn(effective, name)) effective[name] = value;
      }
    }
    const result = inspectConfigurationCompatibility({ profile, environment: effective });
    const check = async () => {
      try {
        signal?.throwIfAborted();
        const currentRoot = await realDirectory(project);
        const info = await lstat(currentRoot, { bigint: true });
        if (currentRoot !== root || info.dev !== rootIdentity.dev || info.ino !== rootIdentity.ino) {
          throw refusal('configuration-changed');
        }
        for (const { source, observed } of retained) {
          signal?.throwIfAborted();
          if (!same(await observe(source.path, source.optional), observed)) throw refusal('configuration-changed');
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.code === 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED') throw error;
        throw refusal('configuration-recheck');
      }
    };
    await check();
    return Object.freeze({ ...result, providers: Object.freeze(result.providers),
      files: Object.freeze(retained.map(({ source, observed }) =>
        Object.freeze({ path: source.path, kind: source.kind, present: observed !== null }))), check });
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'DEPLOYMENT_CONFIGURATION_UNSUPPORTED') throw error;
    throw refusal('configuration-inspection');
  }
}
