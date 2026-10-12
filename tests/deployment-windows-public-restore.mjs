import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export async function invokePublicWindowsRestore({ project, taskName, pwsh, acknowledge = true }) {
  const entry = fileURLToPath(new URL('../scripts/restore.ps1', import.meta.url));
  const pending = promisify(execFile)(pwsh, [
    '-NoProfile', '-NonInteractive', '-File', entry, '-ProjectDir', project,
    '-TaskName', taskName, '-TimeoutSeconds', '1800', '-Json', ...(acknowledge ? ['-AcceptDataLoss'] : []),
  ], {
    env: { ...process.env, PATH: [path.dirname(process.execPath), path.dirname(pwsh)].join(path.delimiter) },
    timeout: 2600000, maxBuffer: 32768,
  });
  pending.child.stderr.on('data', bytes => process.stderr.write(bytes));
  let output;
  let code = 0;
  try { output = await pending; }
  catch (error) {
    assert.equal(error.killed, false);
    assert.equal(error.signal, null);
    assert.equal(error.code, 1);
    output = error;
    code = error.code;
  }
  assert.equal(output.stdout.trim().split('\n').length, 1);
  return { code, result: JSON.parse(output.stdout) };
}
