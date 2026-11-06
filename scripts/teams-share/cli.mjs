#!/usr/bin/env node
// Give colleagues the Teams bot, or take it away, in one step: share the Teams app through the
// Microsoft 365 Agents Toolkit CLI (atk), update TEAMS_ALLOWED_USERS in shared/.env.local, and
// restart the service. See docs/teams-bot.md#share-the-bot-with-colleagues.
//
// Run it through scripts/teams-share.ps1 (Windows) or scripts/teams-share.sh (Linux).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { KEY, UsageError, parseEmails, readAllowList, updateAllowList } from './allowlist.mjs';
import { inspectLock, isWin, readJson, waitHealthy } from '../deploy/fsops.mjs';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATK_TIMEOUT_MS = 5 * 60 * 1000;
const USAGE = `Usage: scripts/teams-share.ps1 (Windows) or scripts/teams-share.sh (Linux),
       <add|remove|list> [emails...] [options]

  add a@x.com,b@x.com   Share the Teams app with them, allow them in ${KEY}, restart.
  remove a@x.com        Remove them from ${KEY}, restart, revoke the Teams share.
  list                  Show ${KEY} and the shared app's link.

Options (in PowerShell: -ProjectDir, -TeamsAppDir, -Env, -NoRestart, -WaitSeconds, -DryRun):
  --project-dir <dir>    Deployment root (default: AGENTS_CHAT_PROJECT_DIR, or the root
                         this script was deployed into).
  --teams-app-dir <dir>  atk project folder (default: <project-dir>/shared/teams-app).
  --env <name>           atk environment (default: dev).
  --no-restart           Do not restart; the change applies at the next restart.
  --wait <seconds>       How long to wait for the service to become healthy (default: 120).
  --dry-run              Check everything and show the plan without changing anything.

Restarting needs an elevated PowerShell (Windows) or root (Linux).`;

const say = (msg) => process.stderr.write(`[teams-share] ${msg}\n`);
// Option names as the user typed them: teams-share.ps1 parameters on Windows, --flags elsewhere.
const PS_NAMES = { 'project-dir': '-ProjectDir', env: '-Env', 'no-restart': '-NoRestart', wait: '-WaitSeconds' };
const flag = (name) => (isWin ? PS_NAMES[name] : `--${name}`);

class StepError extends Error {}

function resolveRoot(option) {
  const given = option ?? process.env.AGENTS_CHAT_PROJECT_DIR;
  if (given) return path.resolve(given);
  // Deployed copies live in <root>/releases/<id>/scripts (reached through <root>/current).
  const release = path.dirname(SCRIPTS_DIR);
  if (path.basename(release) === 'current') return path.dirname(release);
  if (path.basename(path.dirname(release)) === 'releases') return path.dirname(path.dirname(release));
  throw new UsageError(`Give ${flag('project-dir')} (the deployment root that contains shared/).`);
}

function readEnvValue(file, key) {
  const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
  return m?.[1].replace(/^(['"])(.*)\1$/, '$2') ?? '';
}

// atk is a .cmd shim on Windows, which Node can only start through a shell. Arguments are
// validated (emails) or checked (paths) so nothing in them is interpreted by cmd.exe.
function atk(args, { capture = false } = {}) {
  const opts = {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8',
    timeout: ATK_TIMEOUT_MS,
    windowsHide: true,
  };
  const res = isWin
    ? spawnSync(`atk ${args.map((a) => `"${a}"`).join(' ')}`, { ...opts, shell: true })
    : spawnSync('atk', args, opts);
  if (res.error?.code === 'ETIMEDOUT') res.failure = `atk ${args[0]} did not finish within ${ATK_TIMEOUT_MS / 60000} minutes`;
  else if (res.error) res.failure = `atk could not start (${res.error.message})`;
  else if (res.status !== 0) res.failure = `atk ${args.slice(0, 2).join(' ')} exited with ${res.status}`;
  res.output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return res;
}

function isElevated() {
  if (!isWin) return process.getuid() === 0;
  return spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status === 0;
}

// Collect every problem up front so a run either changes nothing or has what it needs.
function preflight(ctx) {
  const errors = [];
  if (!fs.existsSync(ctx.envFile)) {
    errors.push(`${ctx.envFile} not found. Is ${flag('project-dir')} the deployment root?`);
  } else {
    try {
      ctx.allowList = readAllowList(fs.readFileSync(ctx.envFile, 'utf8'));
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (ctx.op === 'list') return errors;

  const atkEnv = path.join(ctx.teamsDir, 'env', `.env.${ctx.env}`);
  if (!fs.existsSync(path.join(ctx.teamsDir, 'm365agents.yml'))) {
    errors.push(`${ctx.teamsDir} has no m365agents.yml. Set it up first (docs/teams-bot.md, "Share the bot with colleagues").`);
  } else if (!fs.existsSync(atkEnv) || !readEnvValue(atkEnv, 'M365_TITLE_ID')) {
    // Checked here because atk silently creates a missing env file and then fails.
    errors.push(`${atkEnv} has no M365_TITLE_ID. Upload the app first: atk provision --env ${ctx.env} -f "${ctx.teamsDir}" -i false`);
  }
  if (isWin && /["%\r\n]/.test(ctx.teamsDir)) errors.push(`The folder path must not contain " or %: ${ctx.teamsDir}`);

  const version = atk(['--version'], { capture: true });
  if (version.failure) {
    errors.push('The atk CLI was not found. Install it: npm install -g @microsoft/m365agentstoolkit-cli');
  } else {
    const auth = atk(['auth', 'list', 'm365'], { capture: true });
    ctx.account = auth.output.match(/account is:\s*(\S+?)\.?\s*$/m)?.[1];
    if (!ctx.account) errors.push('atk is not signed in to Microsoft 365. Run: atk auth login m365');
  }

  if (ctx.restart) {
    if (!ctx.service.name) {
      errors.push(`${path.join(ctx.root, 'state.json')} does not name the service, so it cannot be restarted. Pass ${flag('no-restart')} and restart it yourself.`);
    }
    if (!isElevated()) {
      errors.push(isWin
        ? `Restarting needs an elevated PowerShell. Run as administrator, or pass ${flag('no-restart')}.`
        : `Restarting needs root. Run with sudo, or pass ${flag('no-restart')}.`);
    }
    if (fs.existsSync(path.join(ctx.root, 'deploy.lock')) && inspectLock(ctx.root) === 'held') {
      errors.push('A deployment is running (deploy.lock is held). Retry when it finishes.');
    }
  }
  return errors;
}

function share(ctx) {
  say(`Sharing the Teams app with ${ctx.emails.join(', ')}...`);
  const res = atk(['share', '--env', ctx.env, '-f', ctx.teamsDir, '--scope', 'users', '--email', ctx.emails.join(','), '-i', 'false']);
  if (res.failure) throw new StepError(`${res.failure}; see its output above.`);
}

function unshare(ctx) {
  say(`Revoking the Teams share for ${ctx.emails.join(', ')}...`);
  const res = atk(['share', 'remove', '--env', ctx.env, '-f', ctx.teamsDir, '--users', ctx.emails.join(','), '-i', 'false']);
  if (res.failure) throw new StepError(`${res.failure}; see its output above.`);
}

// Writes in place (keeping the file's owner and permissions) after saving a .bak copy,
// then reads the file back to confirm the change landed.
function saveAllowList(ctx) {
  const before = fs.readFileSync(ctx.envFile, 'utf8');
  const { text, changed, list } = updateAllowList(before, ctx.op, ctx.emails);
  if (!changed.length) {
    say(`${KEY} already ${ctx.op === 'add' ? 'includes' : 'excludes'} them; no change.`);
    return false;
  }
  const backup = `${ctx.envFile}.bak`;
  fs.copyFileSync(ctx.envFile, backup);
  try {
    fs.writeFileSync(ctx.envFile, text);
    const saved = readAllowList(fs.readFileSync(ctx.envFile, 'utf8')).map((e) => e.toLowerCase());
    if (changed.some((e) => saved.includes(e) !== (ctx.op === 'add'))) throw new Error('the file did not read back as expected');
  } catch (err) {
    fs.copyFileSync(backup, ctx.envFile);
    throw new StepError(`Could not update ${ctx.envFile} (${err.message}); it was restored from ${backup}.`);
  }
  say(`${KEY} ${ctx.op === 'add' ? 'now includes' : 'no longer includes'} ${changed.join(', ')} (previous file: ${backup}).`);
  if (!list.length) say(`Warning: ${KEY} is now empty, so the bot ignores everyone, including you.`);
  return true;
}

async function restart(ctx) {
  const { service, name } = ctx;
  if (isWin) {
    say(`Restarting ${name}...`);
    const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(SCRIPTS_DIR, 'restart.ps1'), '-TaskName', name, '-WaitSeconds', String(ctx.wait)],
    { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    if (res.error || res.status !== 0) throw new StepError(`restart.ps1 failed (${res.error?.message ?? `exit ${res.status}`}).`);
    return;
  }
  say(`Restarting ${name}...`);
  const res = spawnSync('systemctl', ['restart', name], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (res.error || res.status !== 0) throw new StepError(`systemctl restart ${name} failed (${res.error?.message ?? `exit ${res.status}`}).`);
  try {
    await waitHealthy(Number(service.port ?? 3010), ctx.wait);
  } catch (err) {
    throw new StepError(`${err.message} See: journalctl -u ${name}`);
  }
  say('Service is healthy.');
}

function restartHint(ctx) {
  return isWin
    ? `From an elevated PowerShell: & "${path.join(SCRIPTS_DIR, 'restart.ps1')}" -TaskName "${ctx.name}"`
    : `sudo systemctl restart ${ctx.name}`;
}

// Runs the steps in an order where a failure part-way never grants more than intended:
// add shares in Teams before allowing in agents-chat; remove disallows before unsharing.
async function apply(ctx) {
  const done = [];
  const fail = (err, next) => {
    say(`FAILED: ${err.message}`);
    say(done.length ? `Already done: ${done.join('; ')}.` : 'Nothing was changed.');
    say(`To finish: ${next}`);
    return 1;
  };
  const rerun = `rerun the same command (each step is safe to repeat)${ctx.restart ? '' : ` with ${flag('no-restart')}`}.`;

  let changed;
  if (ctx.op === 'add') {
    try {
      share(ctx);
    } catch (err) {
      return fail(err, `fix the problem above and ${rerun}`);
    }
    done.push('shared in Teams');
  }
  try {
    changed = saveAllowList(ctx);
  } catch (err) {
    return fail(err, rerun);
  }
  if (changed) done.push(`${KEY} updated`);

  if (changed && ctx.restart) {
    try {
      await restart(ctx);
      done.push('service restarted');
    } catch (err) {
      const next = ctx.op === 'add'
        ? `restart the service so ${KEY} takes effect. ${restartHint(ctx)}`
        : `restart the service, then revoke the Teams share: atk share remove --env ${ctx.env} -f "${ctx.teamsDir}" --users ${ctx.emails.join(',')} -i false`;
      return fail(err, next);
    }
  }

  if (ctx.op === 'remove') {
    try {
      unshare(ctx);
    } catch (err) {
      return fail(err, `revoke it by hand: atk share remove --env ${ctx.env} -f "${ctx.teamsDir}" --users ${ctx.emails.join(',')} -i false`);
    }
    done.push('Teams share revoked');
  }

  say(`Done: ${done.join('; ') || 'nothing needed changing'}.`);
  if (changed && !ctx.restart) say(`Restart the service for ${KEY} to take effect. ${restartHint(ctx)}`);
  if (ctx.op === 'add') {
    const link = readEnvValue(path.join(ctx.teamsDir, 'env', `.env.${ctx.env}`), 'SHARE_LINK');
    say('The bot now appears in their Teams apps' + (link ? `; you can also send them ${link}` : '') + '.');
    say('The bot answers them only for agents they can already use (shared with them from the agent\'s Access Control).');
  }
  return 0;
}

async function main(argv) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'project-dir': { type: 'string' },
      'teams-app-dir': { type: 'string' },
      env: { type: 'string', default: 'dev' },
      'no-restart': { type: 'boolean', default: false },
      wait: { type: 'string', default: '120' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  const [op, ...rest] = positionals;
  if (!['add', 'remove', 'list'].includes(op)) throw new UsageError('Choose add, remove, or list.');
  if (!/^[A-Za-z0-9_-]+$/.test(o.env)) throw new UsageError(`Invalid ${flag('env')}: ${o.env}`);
  const wait = Number(o.wait);
  if (!Number.isInteger(wait) || wait < 0) throw new UsageError(`Invalid ${flag('wait')}: ${o.wait}`);
  const root = resolveRoot(o['project-dir']);
  const ctx = {
    op,
    root,
    env: o.env,
    wait,
    restart: !o['no-restart'],
    emails: op === 'list' ? [] : parseEmails(rest),
    envFile: path.join(root, 'shared', '.env.local'),
    teamsDir: path.resolve(o['teams-app-dir'] ?? path.join(root, 'shared', 'teams-app')),
    service: readJson(path.join(root, 'state.json'), {})?.service ?? {},
  };
  ctx.name = ctx.service.name;

  const errors = preflight(ctx);
  if (errors.length) {
    for (const e of errors) say(`ERROR: ${e}`);
    say('Nothing was changed.');
    return 2;
  }

  if (op === 'list') {
    console.log(`${KEY} (${ctx.allowList.length}): ${ctx.allowList.join(', ') || '(empty: the bot ignores everyone)'}`);
    const atkEnv = path.join(ctx.teamsDir, 'env', `.env.${ctx.env}`);
    if (fs.existsSync(atkEnv)) console.log(`Share link: ${readEnvValue(atkEnv, 'SHARE_LINK') || '(none yet)'}`);
    return 0;
  }

  say(`Signed in to atk as ${ctx.account}.`);
  if (o['dry-run']) {
    const steps = op === 'add'
      ? ['atk share', `add to ${KEY}`, ctx.restart && 'restart if it changed']
      : [`remove from ${KEY}`, ctx.restart && 'restart if it changed', 'atk share remove'];
    say(`Dry run: would ${op} ${ctx.emails.join(', ')}: ${steps.filter(Boolean).join(', then ')}. Checks passed.`);
    return 0;
  }
  return apply(ctx);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UsageError || err.code?.startsWith?.('ERR_PARSE_ARGS')) {
      say(`ERROR: ${err.message}`);
      process.stderr.write(`\n${USAGE}\n`);
      process.exit(2);
    }
    say(`ERROR: ${err.stack ?? err.message}`);
    process.exit(1);
  },
);
