import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { realDirectory } from './snapshot-files.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { captureWorkerCommand } from './worker-wire.mjs';

async function explicitFile(file, executable = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) {
    throw new Error('npm execution requires explicit absolute Node and npm CLI paths.');
  }
  const target = await realpath(file);
  const info = await lstat(target);
  if (!info.isFile() || executable && process.platform === 'linux' && !(info.mode & 0o111)) {
    throw new Error('npm execution requires installed Node and npm CLI files.');
  }
  return target;
}

async function readPackageFile(project, name, maximum) {
  const bytes = await readWorkerFile(path.join(project, name), maximum);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (cause) { throw new Error(`Invalid deployment ${name}.`, { cause }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid deployment ${name}.`);
  return value;
}

// Commands are submitted to the enrolled native operation; preparation does not spawn anything.
export async function prepareNpmCommand({ project, node, npmCli, stage, environment, signal }) {
  signal?.throwIfAborted();
  if (!['dependencies', 'build'].includes(stage)) throw new Error('Unsupported deployment npm stage.');
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || Object.keys(environment).some(key => ['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase()))) {
    throw new Error('Unsupported deployment npm environment.');
  }
  if (typeof node !== 'string' || !path.isAbsolute(node)) {
    throw new Error('npm execution requires explicit absolute Node and npm CLI paths.');
  }
  const suppliedEnvironment = captureWorkerCommand({ file: node, cwd: project, args: [], env: environment }).env;
  const root = await realDirectory(project);
  await explicitFile(node, true);
  const cli = await explicitFile(npmCli);
  if (path.basename(cli) !== 'npm-cli.js') throw new Error('Specify npm-cli.js, not an npm shell or cmd wrapper.');
  const pkg = await readPackageFile(root, 'package.json', 1024 * 1024);
  if (stage === 'dependencies') {
    const lock = await readPackageFile(root, 'package-lock.json', 16 * 1024 * 1024);
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object'
      || Array.isArray(lock.packages)) throw new Error('Deployment requires an npm v2/v3 package lock.');
  } else if (typeof pkg.scripts?.build !== 'string' || !pkg.scripts.build.trim()) {
    throw new Error('Deployment requires an explicit package build script.');
  }
  const paths = Object.entries(suppliedEnvironment).filter(([key]) => key.toUpperCase() === 'PATH');
  if (paths.length > 1 || paths.some(([, value]) => typeof value !== 'string')) {
    throw new Error('Ambiguous deployment npm PATH environment.');
  }
  const env = Object.fromEntries(Object.entries(suppliedEnvironment).filter(([key]) => key.toUpperCase() !== 'PATH'));
  env.PATH = [path.dirname(node), ...(paths.length ? [paths[0][1]] : [])].join(path.delimiter);
  signal?.throwIfAborted();
  return captureWorkerCommand({
    file: node, cwd: root, env,
    args: [cli, ...(stage === 'dependencies' ? ['ci', '--include=dev', '--no-audit', '--no-fund'] : ['run', 'build'])],
  });
}
