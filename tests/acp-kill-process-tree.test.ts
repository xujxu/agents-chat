// killProcessTree (lib/acp/rpc.ts): agents are spawned with `shell: true`, so a plain
// cp.kill() only ends cmd.exe / sh and can leave the agent running.
// Stopping/restarting an agent must end the agent process itself.
// Locally: npx --yes --package=tsx@4.20.6 tsx --test tests/acp-kill-process-tree.test.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { killProcessTree } from '../lib/acp/rpc';

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('killProcessTree ends the agent spawned behind the shell', async () => {
  const script = 'process.stdout.write(String(process.pid)+"\\n");setInterval(()=>{},1000)';
  const cp = spawn(`"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"`, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const agentPid = await new Promise<number>((resolve, reject) => {
    cp.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    cp.once('error', reject);
  });
  assert.ok(agentPid > 0 && isAlive(agentPid));

  killProcessTree(cp);

  const deadline = Date.now() + 10_000;
  while (isAlive(agentPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const alive = isAlive(agentPid);
  if (alive) process.kill(agentPid);
  assert.equal(alive, false, 'agent process should not outlive killProcessTree');
});
