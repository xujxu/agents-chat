import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const destination = process.env.DEPLOYMENT_TEST_CLOSEOUT_TRACE;
if (!destination || !path.isAbsolute(destination)) throw new Error('Explicit closeout fixture trace path required.');
const started = performance.now();
const events = [];
const record = event => {
  events.push({ elapsedMs: Math.round(performance.now() - started), ...event });
  if (events.length > 32) events.shift();
  writeFileSync(destination, JSON.stringify(events), { mode: 0o600 });
};
record({ event: 'preload', pid: process.pid });
const spawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  const child = spawn.call(this, file, args, options);
  const script = args?.find(value => typeof value === 'string'
    && /(?:windows-admission|windows-task-completion-controller|windows-task-completion-recovery-controller)\.ps1$/i.test(value));
  if (!script) return child;
  const context = { pid: child.pid, script: path.basename(script) };
  record({ ...context, event: 'spawn' });
  const write = child.stdin.write;
  child.stdin.write = function (chunk, ...rest) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    record({ ...context, event: 'send', method: /"method"\s*:\s*"([a-z-]+)"/.exec(text)?.[1] ?? null });
    return write.call(this, chunk, ...rest);
  };
  child.stdout.on('data', chunk => {
    const text = chunk.toString('utf8');
    record({
      ...context, event: 'receive', bytes: chunk.length,
      type: /"type"\s*:\s*"([a-z-]+)"/.exec(text)?.[1] ?? null,
      status: /"status"\s*:\s*"([a-z-]+)"/.exec(text)?.[1] ?? null,
    });
  });
  child.once('exit', (code, signal) => record({ ...context, event: 'exit', code, signal }));
  return child;
};
syncBuiltinESMExports();
