import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

export async function invokeSavedWindowsRestore({
  saved, control, input, acknowledge = true, manifestSha256 = saved.manifestSha256,
  entry = path.join(saved.directory, 'windows-restore-entry.mjs'), extraArgs = [],
  rawInput, timeout = 60000, forwardDiagnostics = false,
}) {
  const pending = promisify(execFile)(process.execPath, [
    entry, control, manifestSha256, ...(acknowledge ? ['--accept-data-loss'] : []), ...extraArgs,
  ], { cwd: saved.directory, timeout, maxBuffer: 32768 });
  let inputError;
  pending.child.stdin.on('error', error => { inputError = error; });
  if (forwardDiagnostics) pending.child.stderr.on('data', bytes => process.stderr.write(bytes));
  pending.child.stdin.end(rawInput ?? JSON.stringify(input));
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
  // A bounded-input refusal may close stdin early, but still must return its failure protocol.
  if (inputError && (inputError.code !== 'EPIPE' || code === 0)) throw inputError;
  assert.equal(output.stdout.trim().split('\n').length, 1);
  return { code, result: JSON.parse(output.stdout), stderr: output.stderr };
}
