import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerCommand, workerWire } from './worker-wire.mjs';
import { captureWorkerFields, captureLinuxAccount } from './worker-identity.mjs';

const [socketPath, token, controllerPid, controllerIdentity] = process.argv.slice(2);
let socket;
let watch;
const die = () => process.exit(1);
try {
  if (process.platform !== 'linux' || !/^[a-f0-9]{64}$/.test(token ?? '')
    || !/^[1-9][0-9]*$/.test(controllerPid ?? '') || !controllerIdentity) throw new Error('Invalid bootstrap.');
  if (await processIdentity(Number(controllerPid)) !== controllerIdentity) throw new Error('Controller changed.');
  socket = createConnection(socketPath);
  const wire = workerWire(socket);
  socket.on('close', die);
  socket.on('error', die);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let checking = false;
  watch = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (await processIdentity(Number(controllerPid)) !== controllerIdentity) die();
    } catch { die(); }
    finally { checking = false; }
  }, 500);
  const membership = (await readFile('/proc/self/cgroup', 'utf8')).trim();
  if (!membership.startsWith('0::/') || membership.includes('\n')) throw new Error('Unsupported cgroup.');
  await wire.send({
    type: 'ready', token, pid: process.pid, processIdentity: await processIdentity(process.pid),
    controlGroup: membership.slice(3),
  });
  const grant = captureWorkerFields(await wire.receive(), ['type', 'command', 'account'], 'grant');
  if (grant.type !== 'run') throw new Error('Invalid grant.');
  const command = captureWorkerCommand(grant.command);
  const account = captureLinuxAccount(grant.account);
  if (await processIdentity(Number(controllerPid)) !== controllerIdentity || socket.destroyed) {
    throw new Error('Lost grant authority.');
  }
  // Only this isolated trusted bootstrap changes groups; the deployment CLI does not.
  process.setgroups([]);
  if (process.getgroups().some(group => group !== process.getgid())) throw new Error('Cannot clear supplementary groups.');
  const child = spawn(command.file, command.args, {
    cwd: command.cwd, env: command.env, uid: account.uid, gid: account.gid,
    shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]).subarray(-8192); });
  child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-8192); });
  child.on('error', die);
  child.once('exit', (exitCode, signal) => {
    wire.send({
      type: 'result', exitCode, signal,
      stdout: stdout.toString('base64'), stderr: stderr.toString('base64'),
    }).catch(die);
  });
  // A second grant is always invalid; remain alive until the owner closes transport.
  await wire.receive({ timeoutMs: 1800000 });
  throw new Error('Duplicate native grant.');
} catch {
  clearInterval(watch);
  process.stderr.write('Native Linux bootstrap failed; no further commands are admitted.\n');
  socket?.destroy();
  process.exitCode = 1;
  die();
}
