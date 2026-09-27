import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';

const [action, project] = process.argv.slice(2);
assert.equal(process.getuid(), 0);
assert.ok(path.isAbsolute(project));
const unit = '/etc/systemd/system/agents-chat.service';
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const listeners = () => command('ss', ['-ltnp', 'sport = :3010']).split('\n').slice(1).filter(Boolean);
const properties = () => Object.fromEntries(command('systemctl', ['show', 'agents-chat',
  '--property=WorkingDirectory,User,Group,MainPID,ActiveState,ControlGroup,InvocationID,ExecStart'])
  .split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
function owned() {
  assert.ok(existsSync(unit), 'Owned service unit missing');
  const p = properties();
  assert.equal(p.WorkingDirectory, project, 'Foreign service working directory');
  assert.match(readFileSync(unit, 'utf8'), /UnsetEnvironment=GH_TOKEN GITHUB_TOKEN/);
  assert.equal(p.User, 'root');
  return p;
}
let result;
if (action === 'preflight') {
  assert.equal(existsSync(unit), false, 'Preexisting service');
  assert.equal(command('systemctl', ['show', 'agents-chat', '--property=LoadState', '--value']), 'not-found');
  assert.equal(existsSync('/etc/agents-chat.env'), false, 'Machine override exists');
  assert.equal(listeners().length, 0, 'App port occupied');
  result = { isolated: true };
} else if (action === 'probe') {
  const p = owned();
  assert.equal(p.ActiveState, 'active');
  const pid = Number(p.MainPID);
  assert.ok(pid > 0);
  const listenerIds = [...new Set(listeners().flatMap(line => [...line.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]))))];
  assert.equal(listenerIds.length, 1, 'Expected one app listener');
  const listenerPid = listenerIds[0];
  const cgroup = readFileSync(`/proc/${listenerPid}/cgroup`, 'utf8');
  assert.ok(cgroup.split('\n').some(line => line.endsWith(`:${p.ControlGroup}`)), 'Listener outside service cgroup');
  const env = readFileSync(`/proc/${listenerPid}/environ`, 'utf8').split('\0');
  assert.ok(!env.some(value => /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)=/i.test(value)),
    'Acquisition credentials entered service');
  const temporaryDirectories = readdirSync(`/proc/${pid}/root/tmp`).filter(name => name.startsWith('agents-chat-voice-')).sort();
  result = { manager: 'systemd', project, active: true, owned: true, pid, listenerPid,
    identity: `${p.User}:${p.Group}`, activation: p.InvocationID, credentialsAbsent: true,
    credentialEvidence: 'Actual listening process environ and unit UnsetEnvironment',
    temporaryDirectories, controlGroup: p.ControlGroup, execStart: p.ExecStart };
} else if (action === 'cleanup') {
  const receipt = JSON.parse(readFileSync(path.join(project, '.service-e2e-owner.json'), 'utf8'));
  assert.equal(receipt.project, project);
  if (existsSync(unit)) {
    owned();
    command('systemctl', ['disable', '--now', 'agents-chat']);
    unlinkSync(unit);
    command('systemctl', ['daemon-reload']);
  }
  assert.equal(listeners().length, 0, 'App port remains open');
  result = { removed: !existsSync(unit), portClosed: true };
} else throw new Error('Unknown service driver action');
console.log(JSON.stringify(result));
