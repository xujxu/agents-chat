import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArguments, quoteArgument } from './cli.mjs';
import { deploymentDiagnostics } from './deployment-diagnostics.mjs';

function helpText(operation) {
  const update = operation === 'update';
  return `Usage: sudo bash scripts/${operation}.sh [options]

${update
    ? 'Update an existing running agents-chat.service using its installed account,\nNode/npm executables and configuration. Requires a Node.js 24+ controller,'
    : 'Deploy a fresh non-root-owned checkout or redeploy an existing running\nagents-chat.service with its installed account and configuration. Requires Node.js 24,'}
/usr/bin/git, systemd and a supported clean source checkout.

  --project-dir PATH  Absolute installed checkout (default: this tools checkout)
  --revision SHA      Full locally available commit; conflicts with --no-pull
  --no-pull           Keep the current source revision
  --no-install        Skip npm ci ${update ? '' : 'for an existing running installation '}but still build and verify
  --wait SECONDS     Positive readiness wait (default: 120)
  --timeout SECONDS  Positive per-stage deadline (default: 1800)
  --status           Read-only operation status; does not create control files
${update ? '  --dry-run          Read-only local preview; no fetch, lock, backup or build\n' : ''}  --json             Emit one JSON result on stdout; progress/errors on stderr
  --help             Show this help

${update ? `This staged implementation supports running-service updates only.
First installation, inactive services, --verify and --wait 0 are not
yet supported here. It does not fall back to the legacy deploy script.
Preview reports local revisions, estimated space and pending checks; it is not
admission. Source cleanliness, database compatibility and remote freshness
require the real update. No target code, Git filters or hooks run in preview.`
    : `First installation requires an absent service, no prior runtime artifacts or
operation evidence, and prepared private production authentication configuration.
Prepare the source checkout as its non-root runtime owner before using sudo.
Packages, accounts and configuration are not automatically installed or changed.
Existing running deployments are backed up before source replacement. A failed
first installation has no previous backup; preserve its operation evidence.
Inactive/failed services, --verify, --wait 0 and deploy --dry-run are not yet
supported. There is no fallback to the legacy root build/install procedure.`}
In-place deployment operations capture controller code outside the installed checkout before
source replacement. Status/help${update ? '/preview' : ''} are read-only and do not capture helpers.
Backup and recovery evidence live in the private sibling .<project>.deployment
directory. Preserve it after failure; never manually remove a lock.
Readiness uses port 3010; admission reserves a minimum 2 GiB build-space budget.
`;
}

function render(result) {
  if (result.status !== 'preview') return `${result.message ?? result.status}${result.phase ? ` (phase=${result.phase})` : ''}\n`;
  return [
    'Preview only; no update or admission was performed.',
    `Current: ${result.inspection.sourceCommit}`,
    `Local target: ${result.target?.commit ?? 'unknown (pending)'}`,
    `Backup: ${result.estimate.backupLocation}`,
    `Estimated required bytes: ${result.estimate.requiredBytes}`,
    `Planned steps: ${result.steps.join(' -> ')}`,
    `Pending checks: ${result.pendingChecks.join(', ')}`,
    'Remote refs were not refreshed.',
    '',
  ].join('\n');
}

export async function runLinuxCommandEntry({ operation, entryUrl, args = process.argv.slice(2) }) {
  if (!['deploy', 'update'].includes(operation)) throw new Error('Unsupported Linux command entry.');
  const project = fileURLToPath(new URL('../../', entryUrl));
  const script = path.join(project, `scripts/${operation}.sh`);
  const json = args.includes('--json');
  let options;
  let captured;
  try {
    options = parseArguments(operation, args);
    if (options.help) {
      const help = helpText(operation);
      process.stdout.write(json ? `${JSON.stringify({ status: 'help', message: help })}\n` : help);
    } else {
      const major = Number(process.versions.node.split('.')[0]);
      if (operation === 'deploy' ? major !== 24 : major < 24) {
        throw Object.assign(new Error('Unsupported controller Node.js version.'), { code: 'DEPLOYMENT_NODE_REQUIRED' });
      }
      if (options.operation === operation && !options.dryRun && options.waitSeconds > 0) {
        const { captureLinuxController } = await import('./linux-controller-capture.mjs');
        captured = await captureLinuxController({ source: project, project: options.project ?? project, operation });
      }
      const command = await import(captured
        ? pathToFileURL(captured.entrypoint).href : new URL(`./linux-${operation}-command.mjs`, import.meta.url).href);
      const invoke = operation === 'deploy' ? command.runLinuxDeployCommand : command.runLinuxUpdateCommand;
      const started = performance.now();
      const result = await invoke({
        args, project,
        onProgress({ phase }) {
          process.stderr.write(`Deployment phase: ${phase}; elapsed=${Math.round((performance.now() - started) / 1000)}s; stage-timeout=${options.timeoutSeconds}s\n`);
        },
      });
      await captured?.close();
      process.stdout.write(json ? `${JSON.stringify(result)}\n` : render(result));
    }
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code : options ? `DEPLOYMENT_${operation.toUpperCase()}_FAILED` : 'DEPLOYMENT_ARGUMENTS_INVALID';
    const check = typeof error?.check === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(error.check) ? error.check : null;
    const message = code === 'DEPLOYMENT_COMMAND_MODE_UNSUPPORTED'
      ? `This native command mode is unsupported; no ${operation} was started.`
      : code === 'DEPLOYMENT_NODE_REQUIRED'
        ? `Install Node.js ${operation === 'deploy' ? '24' : '24 or newer'} for the controller before retrying.`
        : code === 'DEPLOYMENT_GIT_REQUIRED'
          ? 'Install Git at /usr/bin/git before retrying.'
          : error?.backupCreated === false
            ? 'Linux deploy failed; no previous backup exists. Preserve lock and recovery evidence; inspect status before retrying.'
            : `Linux ${operation} failed. Preserve backup, lock and recovery evidence; inspect status before retrying.`;
    const status = `sudo bash ${quoteArgument(script, 'linux')} --project-dir ${quoteArgument(options?.project ?? project, 'linux')} --status --json`;
    const logs = 'sudo journalctl --no-pager -u agents-chat.service -n 40';
    const roots = [new URL('./', entryUrl).href];
    if (captured) roots.push(new URL('./', pathToFileURL(captured.entrypoint)).href);
    const diagnostics = deploymentDiagnostics(error, roots);
    const result = { status: 'failed', code, check, message, nextActions: { status, logs },
      diagnostics,
      ...(error?.backupCreated === false ? { backupCreated: false } : {}) };
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    process.stderr.write(`${message} (${code}${check ? `; ${check}` : ''})\nStatus: ${status}\nLogs: ${logs}\n`);
    for (const diagnostic of diagnostics) {
      for (const location of diagnostic.locations) {
        process.stderr.write(`Diagnostic: ${diagnostic.code} ${location.module}:${location.line}:${location.column}\n`);
      }
    }
    process.exitCode = 1;
  }
  if (captured) {
    try { await captured.close(); }
    catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'UNKNOWN';
      process.stderr.write(`Controller helper cleanup failed (${code}); retain ${captured.directory} for inspection.\n`);
      process.exitCode = 1;
    }
  }
}
