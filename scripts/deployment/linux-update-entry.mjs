import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArguments, quoteArgument } from './cli.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(project, 'scripts/update.sh');
const args = process.argv.slice(2);
const json = args.includes('--json');
const help = `Usage: sudo bash scripts/update.sh [options]

Update an existing running agents-chat.service using its installed account,
Node/npm executables and configuration. Requires a Node.js 24+ controller,
/usr/bin/git, systemd and a supported clean source checkout.

  --project-dir PATH  Absolute installed checkout (required for updates)
  --revision SHA      Full locally available commit; conflicts with --no-pull
  --no-pull           Keep the current source revision
  --no-install        Skip npm ci, but still build and verify
  --wait SECONDS     Positive readiness wait (default: 120)
  --timeout SECONDS  Positive per-stage deadline (default: 1800)
  --status           Read-only operation status; does not create control files
  --json             Emit one JSON result on stdout; progress/errors on stderr
  --help             Show this help

This staged implementation supports running-service updates only.
First installation, inactive services, --dry-run, --verify and --wait 0 are not
yet supported here. It does not fall back to the legacy deploy script.
Run the tools from a separate checkout and select the installed checkout with
--project-dir: in-place controller capture is not yet wired. Status defaults
to the tools checkout and is always read-only.
Backup and recovery evidence live in the private sibling .<project>.deployment
directory. Preserve it after failure; never manually remove a lock.
Readiness uses port 3010; admission reserves a minimum 2 GiB build-space budget.
`;

let options;
try {
  options = parseArguments('update', args);
  if (options.help) {
    process.stdout.write(json ? `${JSON.stringify({ status: 'help', message: help })}\n` : help);
  } else {
    if (Number(process.versions.node.split('.')[0]) < 24) {
      throw Object.assign(new Error('Unsupported controller Node.js version.'), { code: 'DEPLOYMENT_NODE_REQUIRED' });
    }
    if (options.operation === 'update' && !options.dryRun && options.waitSeconds > 0) {
      const tools = await realpath(project);
      const installed = await realpath(options.project ?? project);
      if (tools === installed || tools.startsWith(`${installed}${path.sep}`)) {
        throw Object.assign(new Error('Use an external tools checkout.'), { code: 'DEPLOYMENT_EXTERNAL_TOOLS_REQUIRED' });
      }
    }
    const { runLinuxUpdateCommand } = await import('./linux-update-command.mjs');
    const started = performance.now();
    const result = await runLinuxUpdateCommand({
      args, project,
      onProgress({ phase }) {
        process.stderr.write(`Deployment phase: ${phase}; elapsed=${Math.round((performance.now() - started) / 1000)}s; stage-timeout=${options.timeoutSeconds}s\n`);
      },
    });
    process.stdout.write(json ? `${JSON.stringify(result)}\n`
      : `${result.message ?? result.status}${result.phase ? ` (phase=${result.phase})` : ''}\n`);
  }
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code : options ? 'DEPLOYMENT_UPDATE_FAILED' : 'DEPLOYMENT_ARGUMENTS_INVALID';
  const check = typeof error?.check === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(error.check) ? error.check : null;
  const message = code === 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED'
    ? 'This native command mode is unsupported; no update was started.'
    : code === 'DEPLOYMENT_NODE_REQUIRED'
      ? 'Install Node.js 24 or newer for the controller before retrying.'
      : code === 'DEPLOYMENT_GIT_REQUIRED'
        ? 'Install Git at /usr/bin/git before retrying.'
        : code === 'DEPLOYMENT_EXTERNAL_TOOLS_REQUIRED'
          ? 'Run these tools from a separate checkout and pass --project-dir; in-place controller capture is not yet supported.'
        : 'Linux update failed. Preserve backup, lock and recovery evidence; inspect status before retrying.';
  const status = `sudo bash ${quoteArgument(script, 'linux')} --project-dir ${quoteArgument(options?.project ?? project, 'linux')} --status --json`;
  const logs = 'sudo journalctl --no-pager -u agents-chat.service -n 40';
  const result = { status: 'failed', code, check, message, nextActions: { status, logs } };
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  process.stderr.write(`${message} (${code}${check ? `; ${check}` : ''})\nStatus: ${status}\nLogs: ${logs}\n`);
  process.exitCode = 1;
}
