'use strict';

// Workers share the PID and may inherit execArgv; collect the main isolate only.
if (process.env.CPG_MEMORY_PID === String(process.pid)
    && require('node:worker_threads').isMainThread) {
  const net = require('node:net');
  const v8 = require('node:v8');
  const { performance, PerformanceObserver, constants } = require('node:perf_hooks');
  let intervalMs = 2000;
  let burstUntil = 0;
  let previousMalloc;
  let allocationHigh = false;
  let socket;
  let ready = false;
  let sequence = 0;
  let dropped = 0;
  let nextConnect = 0;
  let lastWarning = -Infinity;
  let gcCount = 0;
  let gcMajor = 0;
  let gcDuration = 0;
  let expected = performance.now();
  const socketPath = process.env.CPG_MEMORY_SOCKET;
  const versions = {
    node: process.versions.node, v8: process.versions.v8, sampler: '2',
    cli: process.env.CPG_MEMORY_CLI_VERSION || 'unavailable',
  };
  delete process.env.CPG_MEMORY_PID;
  delete process.env.CPG_MEMORY_SOCKET;
  delete process.env.CPG_MEMORY_CLI_VERSION;

  function warn(reason) {
    const now = performance.now();
    if (now - lastWarning >= 60000) {
      process.stderr.write(`[cpg-memory] ${reason}; numeric sampling is incomplete.\n`);
      lastWarning = now;
    }
  }

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount++;
      gcDuration += entry.duration;
      if (entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) gcMajor++;
    }
  });
  observer.observe({ entryTypes: ['gc'] });

  function sample() {
    const started = performance.now();
    const delay = Math.max(0, started - expected);
    sequence++;
    if (!ready || !socket || socket.destroyed || socket.writableLength > 0) {
      dropped++;
      if (ready) warn('receiver backpressure');
      return;
    }
    const memory = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const code = v8.getHeapCodeStatistics();
    const rising = previousMalloc !== undefined
      && heap.malloced_memory - previousMalloc >= 32 * 1024 * 1024;
    if ((!allocationHigh && heap.malloced_memory >= 64 * 1024 * 1024) || rising) {
      burstUntil = started + 30000;
      allocationHigh = true;
    }
    if (heap.malloced_memory < 32 * 1024 * 1024) allocationHigh = false;
    previousMalloc = heap.malloced_memory;
    intervalMs = started < burstUntil ? 500 : 2000;
    const row = {
      schema: 2,
      sequence,
      sampled_unix_ms: Date.now(),
      uptime_ms: process.uptime() * 1000,
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      heap_limit_bytes: heap.heap_size_limit,
      external_bytes: memory.external,
      array_buffers_bytes: memory.arrayBuffers,
      malloced_bytes: heap.malloced_memory,
      peak_malloced_bytes: heap.peak_malloced_memory,
      native_contexts: heap.number_of_native_contexts,
      detached_contexts: heap.number_of_detached_contexts,
      heap_physical_bytes: heap.total_physical_size,
      global_handles_total_bytes: heap.total_global_handles_size,
      global_handles_used_bytes: heap.used_global_handles_size,
      code_and_metadata_bytes: code.code_and_metadata_size,
      bytecode_and_metadata_bytes: code.bytecode_and_metadata_size,
      external_script_source_bytes: code.external_script_source_size,
      cpu_profiler_metadata_bytes: code.cpu_profiler_metadata_size,
      next_interval_ms: intervalMs,
      versions,
      gc_count: gcCount,
      gc_major_count: gcMajor,
      gc_duration_ms: gcDuration,
      event_loop_delay_ms: delay,
      collection_duration_ms: performance.now() - started,
      dropped_samples: dropped,
    };
    const payload = JSON.stringify(row) + '\n';
    if (Buffer.byteLength(payload) > 2048) {
      dropped++;
      warn('record exceeds numeric protocol bound');
      return;
    }
    socket.write(payload);
  }

  function connect() {
    if (socket || performance.now() < nextConnect) return;
    ready = false;
    let greeting = '';
    const connection = net.createConnection(socketPath);
    socket = connection;
    connection.unref();
    connection.setTimeout(5000, () => {
      warn('receiver handshake timeout');
      connection.destroy();
    });
    connection.on('error', () => warn('receiver unavailable'));
    connection.on('close', () => {
      ready = false;
      socket = undefined;
      nextConnect = performance.now() + 10000;
      warn('receiver disconnected');
    });
    connection.on('data', (data) => {
      if (ready || greeting.length + data.length > 13) {
        warn('invalid receiver response');
        connection.destroy();
        return;
      }
      greeting += data.toString('ascii');
      if (greeting === 'CPG_MEMORY/1\n') {
        ready = true;
        connection.setTimeout(0);
        process.stderr.write('[cpg-memory] internal numeric sampling connected (2s).\n');
        expected = performance.now();
        sample();
      } else if (!'CPG_MEMORY/1\n'.startsWith(greeting)) {
        warn('invalid receiver response');
        connection.destroy();
      }
    });
  }

  connect();
  function tick() {
    connect();
    sample();
    schedule();
  }
  function schedule() {
    // Backpressure must not keep the faster timer alive after its bounded window.
    if (performance.now() >= burstUntil) intervalMs = 2000;
    expected = performance.now() + intervalMs;
    setTimeout(tick, intervalMs).unref();
  }
  schedule();
}
