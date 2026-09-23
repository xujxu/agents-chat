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
  let malloced = 1;
  let scheduledMs = 0;
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
      return { heap_size_limit: 100, malloced_memory: malloced, peak_malloced_memory: malloced,
        total_physical_size: 20, total_global_handles_size: 8, used_global_handles_size: 4,
        number_of_native_contexts: 1, number_of_detached_contexts: 0 };
    }, getHeapCodeStatistics() {
      return { code_and_metadata_size: 1, bytecode_and_metadata_size: 2,
        external_script_source_size: 3, cpu_profiler_metadata_size: 0 };
    } },
    'node:perf_hooks': {
      performance: { now: () => now },
      constants: { NODE_PERFORMANCE_GC_MAJOR: 4 },
      PerformanceObserver: class { observe() {} },
    },
  };
  const process = {
    pid,
    versions: { node: '24.13.0', v8: '13.6.233.17-node.37' },
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
    setTimeout(callback, ms) { tick = callback; scheduledMs = ms; return { unref() {} }; },
  });
  return { writes, warnings, socket, process,
    get collections() { return collections; },
    get connections() { return connections; },
    get scheduledMs() { return scheduledMs; },
    setMalloced(bytes) { malloced = bytes; },
    tick() { now += scheduledMs; tick(); },
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
const burst = fixture();
burst.socket.emit('data', Buffer.from('CPG_MEMORY/1\n'));
assert.equal(burst.scheduledMs, 2000);
burst.socket.writableLength = 0;
burst.setMalloced(64 * 1024 * 1024);
burst.tick();
assert.equal(burst.scheduledMs, 500);
assert.equal(burst.writes.at(-1).schema, 2);
assert.equal(burst.writes.at(-1).versions.node, '24.13.0');
assert.equal(burst.writes.at(-1).code_and_metadata_bytes, 1);
for (let i = 0; i < 60; i++) {
  burst.socket.writableLength = 0;
  burst.tick();
}
assert.equal(burst.scheduledMs, 2000, 'constant high allocation must not burst indefinitely');
burst.socket.writableLength = 0;
burst.setMalloced(1);
burst.tick();
burst.socket.writableLength = 0;
burst.setMalloced(33 * 1024 * 1024);
burst.tick();
assert.equal(burst.scheduledMs, 500, '32 MiB growth must trigger a fresh burst');
console.log('PASS: exact backpressure bound, explicit drops, and worker/descendant exclusion');
