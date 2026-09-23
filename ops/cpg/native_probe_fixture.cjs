'use strict';

const fs = require('node:fs');
const v8 = require('node:v8');
if (typeof global.gc !== 'function') {
  throw new Error('Native probe requires --expose-gc');
}
const marker = process.env.CPG_NATIVE_PROBE_MARKER;
if (!marker) throw new Error('Missing isolated probe marker path');
let transient;
let retained;
function record(phase) {
  fs.appendFileSync(marker, JSON.stringify({
    phase, pid: process.pid, time_ms: Date.now(),
    memory: process.memoryUsage(), heap: v8.getHeapStatistics(),
    usage: process.resourceUsage(),
    versions: { node: process.versions.node, v8: process.versions.v8 },
  }) + '\n');
}
record('start');
setTimeout(() => {
  transient = Buffer.alloc(32 * 1024 * 1024, 1);
  retained = Buffer.alloc(16 * 1024 * 1024, 2);
  record('peak');
}, 2000);
setTimeout(() => {
  transient = undefined;
  global.gc();
  record('released');
}, 4000);
setTimeout(() => {
  if (!retained || retained[0] !== 2) throw new Error('Retained buffer missing');
  record('finished');
  if (process.env.CPG_NATIVE_PROBE_KILL === '1') process.kill(process.pid, 'SIGKILL');
  else process.exit(0);
}, 8000);
