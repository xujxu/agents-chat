'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require.resolve('./memory_sampler_preload.cjs'), 'utf8');

function fixture({ pid = 42, mainThread = true } = {}) {
  const writes = [];
  const warnings = [];
  let tick;
  let now = 0;
  let collections = 0;
  let connections = 0;
  const socket = new EventEmitter();
  Object.assign(socket, {
    writableLength: 0,
    destroyed: false,
    unref() {},
    setTimeout() {},
    write(payload) { writes.push(JSON.parse(payload)); this.writableLength += payload.length; },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  const modules = {
    'node:worker_threads': { isMainThread: mainThread },
    'node:net': { createConnection() { connections++; return socket; } },
    'node:v8': { getHeapStatistics() {
      return { heap_size_limit: 100, malloced_memory: 1, peak_malloced_memory: 1,
        number_of_native_contexts: 1, number_of_detached_contexts: 0 };
    } },
    'node:perf_hooks': {
      performance: { now: () => now },
      constants: { NODE_PERFORMANCE_GC_MAJOR: 4 },
      PerformanceObserver: class { observe() {} },
    },
  };
  const process = {
    pid,
    env: { CPG_MEMORY_PID: '42', CPG_MEMORY_SOCKET: '/private/socket' },
    uptime: () => now / 1000,
    stderr: { write: (text) => warnings.push(text) },
    memoryUsage() {
      collections++;
      return { heapUsed: 10, heapTotal: 20, external: 5, arrayBuffers: 2 };
    },
  };
  vm.runInNewContext(source, {
    require: (name) => modules[name],
    Buffer, process, Date,
    setInterval(callback) { tick = callback; return { unref() {} }; },
  });
  return { writes, warnings, socket, process,
    get collections() { return collections; },
    get connections() { return connections; },
    tick() { now += 2000; tick(); },
  };
}

const active = fixture();
active.socket.emit('data', Buffer.from('CPG_MEMORY/1\n'));
assert.equal(active.writes.length, 1);
for (let i = 0; i < 100; i++) active.tick();
assert.equal(active.writes.length, 1, 'backpressure must not accumulate writes');
assert.equal(active.collections, 1, 'do not collect while output is blocked');
assert(active.warnings.some((text) => text.includes('backpressure')));
active.socket.writableLength = 0;
active.tick();
assert.equal(active.writes.length, 2);
assert.equal(active.writes[1].dropped_samples, 100);
assert.equal(active.process.env.CPG_MEMORY_PID, undefined);
assert.equal(active.process.env.CPG_MEMORY_SOCKET, undefined);
assert.equal(fixture({ pid: 43 }).connections, 0);
assert.equal(fixture({ mainThread: false }).connections, 0);
console.log('PASS: exact backpressure bound, explicit drops, and worker/descendant exclusion');
