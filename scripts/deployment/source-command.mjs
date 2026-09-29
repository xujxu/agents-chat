import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readWorkerFile } from './worker-files.mjs';
import { captureWorkerCommand } from './worker-wire.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { realDirectory } from './snapshot-files.mjs';

const prefix = 'deployment-source:///';
const modules = ['source.mjs', 'snapshot-files.mjs'];
const commit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

function captureSourceResult(action, value) {
  if (action === 'resolve') {
    const record = captureWorkerFields(value,
      value?.mode === 'fast-forward' ? ['commit', 'expectedSourceCommit', 'branch', 'mode']
        : ['commit', 'expectedSourceCommit', 'mode'], 'source target');
    if (!commit(record.commit) || !commit(record.expectedSourceCommit)
      || !['explicit', 'unchanged', 'fast-forward'].includes(record.mode)
      || record.mode === 'fast-forward' && (typeof record.branch !== 'string' || !record.branch || record.branch.length > 1024)) {
      throw new Error('Invalid source target result.');
    }
    return record;
  }
  const record = captureWorkerFields(value, ['project', 'commit', 'branch', 'modifiedRuntime'], 'source inspection');
  if (typeof record.project !== 'string' || !path.isAbsolute(record.project) || !commit(record.commit)
    || record.branch !== null && (typeof record.branch !== 'string' || !record.branch || record.branch.length > 1024)
    || !Array.isArray(record.modifiedRuntime) || record.modifiedRuntime.length > 1
    || record.modifiedRuntime.some(name => name !== 'agents.json')) throw new Error('Invalid source inspection result.');
  return record;
}

async function sourceBootstrap() {
  const { registerHooks } = await import('node:module');
  const { gunzipSync } = await import('node:zlib');
  const payload = JSON.parse(gunzipSync(Buffer.from(process.argv[1], 'base64'), { maxOutputLength: 256 * 1024 }));
  const registry = new Map(payload.modules);
  const prefix = 'deployment-source:///';
  registerHooks({
    resolve(specifier, context, next) {
      const url = specifier.startsWith(prefix) ? specifier
        : context.parentURL?.startsWith(prefix) && specifier.startsWith('.') ? new URL(specifier, context.parentURL).href : null;
      if (url === null) return next(specifier, context);
      if (!registry.has(url)) throw new Error('Source module was not captured.');
      return { url, shortCircuit: true };
    },
    load(url, context, next) {
      if (!url.startsWith(prefix)) return next(url, context);
      if (!registry.has(url)) throw new Error('Source module was not captured.');
      return { format: 'module', source: registry.get(url), shortCircuit: true };
    },
  });
  const source = await import(`${prefix}source.mjs`);
  const execution = { git: payload.git, environment: process.env };
  const result = payload.action === 'inspect' ? await source.inspectSource(payload.project, execution)
    : payload.action === 'resolve' ? await source.resolveTarget(payload.project, payload.options, execution)
      : await source.selectSource(payload.project, payload.options, execution);
  const output = JSON.stringify({ action: payload.action, result });
  if (Buffer.byteLength(output) > 4096) throw new Error('Source result exceeds limit.');
  process.stdout.write(output);
}

export async function prepareSourceCommand({ project, node, git, action, options = {}, environment, signal }) {
  signal?.throwIfAborted();
  if (!['inspect', 'resolve', 'select'].includes(action)) throw new Error('Unsupported owned source action.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid source options.');
  let input;
  if (action === 'select') input = captureSourceResult('resolve', options);
  else if (action === 'inspect') input = captureWorkerFields(options, [], 'source options');
  else {
    if (Object.keys(options).some(key => !['revision', 'noPull'].includes(key))
      || options.revision !== undefined && !commit(options.revision)
      || options.noPull !== undefined && typeof options.noPull !== 'boolean'
      || options.revision !== undefined && options.noPull) throw new Error('Invalid source target options.');
    input = { ...options };
  }
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || Object.keys(environment).some(key => ['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase()))) {
    throw new Error('Unsupported source worker environment.');
  }
  for (const file of [node, git]) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) {
      throw new Error('Source workers require explicit absolute Node and Git executables.');
    }
    const info = await lstat(await realpath(file));
    if (!info.isFile() || process.platform === 'linux' && !(info.mode & 0o111)) throw new Error('Invalid source executable.');
  }
  const root = await realDirectory(project);
  const captured = [];
  for (const name of modules) {
    const bytes = await readWorkerFile(fileURLToPath(new URL(name, import.meta.url)), 64 * 1024);
    captured.push([`${prefix}${name}`, new TextDecoder('utf-8', { fatal: true }).decode(bytes)]);
  }
  for (const [index, name] of modules.entries()) {
    const bytes = await readWorkerFile(fileURLToPath(new URL(name, import.meta.url)), 64 * 1024);
    if (!bytes.equals(Buffer.from(captured[index][1]))) throw new Error('Source worker modules changed during capture.');
  }
  const payload = gzipSync(Buffer.from(JSON.stringify({ modules: captured, project: root, git, action, options: input }))).toString('base64');
  const code = `(${sourceBootstrap.toString()})().catch(()=>{process.stderr.write("Owned source operation refused; inspect checkout and target configuration.\\n");process.exitCode=1;});`;
  const command = captureWorkerCommand({
    file: node, cwd: root, env: environment,
    args: ['--input-type=module', '--eval', code, '--', payload],
  });
  if (command.args.join(' ').length > 28000) throw new Error('Source command exceeds native command-line budget.');
  signal?.throwIfAborted();
  return command;
}

export function readSourceCommandResult(output, action, project) {
  if (!['inspect', 'resolve', 'select'].includes(action) || typeof output?.stdout !== 'string'
    || Buffer.byteLength(output.stdout) > 4096 || output.stderr !== '' || output.exitCode !== 0 || output.signal !== null) {
    throw new Error('Invalid source worker result.');
  }
  const value = captureWorkerFields(JSON.parse(output.stdout), ['action', 'result'], 'source result');
  if (value.action !== action) throw new Error('Source worker action differs.');
  const result = captureSourceResult(action, value.result);
  if (action !== 'resolve' && result.project !== project) throw new Error('Source worker project differs.');
  return result;
}
