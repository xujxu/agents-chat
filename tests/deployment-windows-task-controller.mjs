import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';
import { stopWindowsTask } from '../scripts/deployment/windows-task-controller.mjs';

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const receive = async () => {
  const result = await lines.next();
  assert.equal(result.done, false, 'Native fixture closed its controller input.');
  return JSON.parse(result.value);
};
console.log(JSON.stringify({ pid: process.pid, identity: await processIdentity(process.pid) }));
const admission = await receive();
await assert.rejects(stopWindowsTask({ ...admission, sha256: '0'.repeat(64), pwsh: process.argv[2] }));
const reason = new Error('Cancelled before native admission.');
await assert.rejects(stopWindowsTask({
  ...admission, pwsh: process.argv[2], signal: AbortSignal.abort(reason),
}), error => error === reason);
const context = await stopWindowsTask({ ...admission, pwsh: process.argv[2] });
const checking = context.check();
await assert.rejects(context.check(), error => error.code === 'DEPLOYMENT_WINDOWS_TASK_UNSETTLED'
  && /already active/.test(error.cause.message));
await assert.rejects(context.close(), error => error.code === 'DEPLOYMENT_WINDOWS_TASK_UNSETTLED'
  && /active task controller request/.test(error.cause.message));
await checking;
await assert.rejects(stopWindowsTask({ ...admission, pwsh: process.argv[2] }));
console.log(JSON.stringify({ phase: 'stopped', bridge: context.identity }));
const { action } = await receive();
if (action === 'exit') process.exit(0);
assert.equal(action, 'close');
await context.close();
await context.close();
await assert.rejects(context.check());
console.log(JSON.stringify({ phase: 'closed' }));
process.exit(0);
