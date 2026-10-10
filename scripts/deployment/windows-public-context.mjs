import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArguments } from './cli.mjs';

const [operation, sourceArgument, projectArgument, taskName, gitArgument, pwshArgument, argumentsJson] = process.argv.slice(2);
try {
  const args = JSON.parse(argumentsJson);
  const options = parseArguments(operation, args);
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) !== 24) {
    throw Object.assign(new Error('Unsupported controller runtime.'), { code: 'DEPLOYMENT_NODE_REQUIRED' });
  }
  const canonical = (value, directory) => {
    if (typeof value !== 'string' || !/^[A-Za-z]:\\/.test(value) || value.length > 4096
      || /[\0\r\n]/.test(value) || value.slice(2).includes(':')) throw new Error('Invalid local path.');
    const resolved = path.resolve(value);
    const real = realpathSync.native(resolved);
    if (real !== resolved || (directory ? !statSync(real).isDirectory() : !statSync(real).isFile())) {
      throw new Error('Canonical local paths are required.');
    }
    return real;
  };
  const source = canonical(sourceArgument, true);
  const project = canonical(projectArgument, true);
  const node = canonical(process.execPath, false);
  const git = canonical(gitArgument, false);
  const pwsh = canonical(pwshArgument, false);
  const npmCli = canonical(path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js'), false);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(taskName)) throw new Error('Invalid managed task name.');
  const within = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  };
  for (const tool of [node, git, pwsh, npmCli]) {
    if (within(project, tool)) throw new Error('Controller tools must be outside mutable source.');
  }
  const parent = canonical(path.dirname(project), true);
  const control = path.join(parent, `.${path.basename(project)}.deployment`);
  const temporary = path.join(parent, `.${path.basename(project)}.deployment-controllers`);
  if ([control, temporary].some(root => within(source, root) || within(root, source))) {
    throw new Error('Controller and control roots must be outside the tools source.');
  }
  process.stdout.write(`${JSON.stringify({
    status: 'ready', operation: options.operation, source, project, control, temporary,
    node, git, pwsh, npmCli, taskName, args,
  })}\n`);
} catch (error) {
  const code = error.code === 'DEPLOYMENT_NODE_REQUIRED' ? error.code : 'DEPLOYMENT_WINDOWS_CONTEXT_REFUSED';
  const message = 'Windows command context refused; require Node 24, canonical local paths and external controller tools.';
  process.stdout.write(`${JSON.stringify({ status: 'failed', code, message })}\n`);
  process.stderr.write(`${message} (${code})\n`);
  process.exitCode = 1;
}
