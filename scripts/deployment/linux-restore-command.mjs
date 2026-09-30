import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { parseArguments } from './cli.mjs';
import { prepareLinuxRestoreInvocation } from './linux-restore-invocation.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const help = `Usage: sudo bash scripts/restore.sh --accept-data-loss [options]

Restore the retained complete backup using its saved external recovery engine.
This replaces source, dependencies, build artifacts and application data with
the backup contents. Export post-backup data before acknowledging its loss.
No Git fetch, dependency installation or application build is performed.

  --project-dir PATH   Absolute installed checkout (default: this tools checkout)
  --accept-data-loss   Required acknowledgement of post-backup data loss
  --timeout SECONDS    Positive per-stage deadline (default: 1800)
  --json               Emit one JSON result; diagnostics stay on stderr
  --help               Show this help

Requires Linux root, Node.js 24+, and a compatible complete Linux service backup
in the private sibling .<project>.deployment directory. Readiness uses port 3010.
If the installed source lacks this script, use a separate tools checkout with
--project-dir or the independently saved recovery entry.
`;

try {
  const options = parseArguments('restore', args);
  if (options.help) {
    process.stdout.write(json ? `${JSON.stringify({ status: 'help', message: help })}\n` : help);
  } else {
    if (!options.acceptDataLoss) {
      throw Object.assign(new Error('Explicit data-loss acknowledgement is required.'),
        { code: 'DEPLOYMENT_DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED' });
    }
    if (Number(process.versions.node.split('.')[0]) < 24) {
      throw Object.assign(new Error('Node.js 24 or newer is required.'), { code: 'DEPLOYMENT_NODE_REQUIRED' });
    }
    const invocation = await prepareLinuxRestoreInvocation({
      project: options.project ?? fileURLToPath(new URL('../../', import.meta.url)),
      timeoutSeconds: options.timeoutSeconds,
    });
    process.stderr.write(`Restoring retained backup ${invocation.backupId}; post-backup data will be replaced.\n`);
    const output = await new Promise((resolve, reject) => {
      const child = execFile(invocation.file, invocation.args, {
        cwd: '/', maxBuffer: 16384,
        timeout: Math.min(options.timeoutSeconds * 16000 + 120000, 2147483647),
        env: { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C', LC_ALL: 'C' },
      }, (error, stdout, stderr) => {
        if (stderr) process.stderr.write(stderr);
        if (error) reject(Object.assign(new Error('Saved restore process failed.', { cause: error }),
          { code: 'DEPLOYMENT_SAVED_RESTORE_FAILED' }));
        else resolve(stdout);
      });
      child.stdin.on('error', reject);
      child.stdin.end(JSON.stringify(invocation.input));
    });
    const result = JSON.parse(output);
    if (!same(result, { status: 'restored', backupId: invocation.backupId })) {
      throw Object.assign(new Error('Saved restore returned an unexpected outcome.'), { code: 'DEPLOYMENT_RESTORE_RESULT_INVALID' });
    }
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `Restored backup ${result.backupId}.\n`);
  }
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code : 'DEPLOYMENT_RESTORE_FAILED';
  const message = code === 'DEPLOYMENT_DATA_LOSS_ACKNOWLEDGEMENT_REQUIRED'
    ? 'Export post-backup data, then provide --accept-data-loss to authorize restoration.'
    : code === 'DEPLOYMENT_NODE_REQUIRED' ? 'Install Node.js 24 or newer for the restore controller.'
      : 'Restore failed. Preserve the backup and all lock/recovery evidence; inspect before retrying.';
  if (json) process.stdout.write(`${JSON.stringify({ status: 'failed', code, message })}\n`);
  process.stderr.write(`${message} (${code})\n`);
  process.exitCode = 1;
}
