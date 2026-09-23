import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { availableMemoryKiB, checkVoiceMemory, monitorVoiceMemory, VOICE_START_MEMORY_KIB, VOICE_MIN_FREE_KIB, VOICE_MAX_RSS_KIB } from '../lib/voice/memory';

test('unknown host memory cannot silently admit transcription', () => {
  assert.equal(availableMemoryKiB('MemTotal: 4000000 kB\nMemAvailable: 900000 kB\n'), 900000);
  assert.throws(() => availableMemoryKiB('MemTotal: 4000000 kB\n'), /voice_memory_unknown/);
});

test('admission requires 768 MiB, and active guards enforce RSS and host headroom independently', () => {
  checkVoiceMemory(VOICE_START_MEMORY_KIB);
  assert.throws(() => checkVoiceMemory(VOICE_START_MEMORY_KIB - 1), /voice_low_memory/);
  checkVoiceMemory(VOICE_MIN_FREE_KIB, VOICE_MAX_RSS_KIB);
  assert.throws(() => checkVoiceMemory(VOICE_MIN_FREE_KIB - 1, 1024), /voice_low_memory/);
  assert.throws(() => checkVoiceMemory(VOICE_START_MEMORY_KIB, VOICE_MAX_RSS_KIB + 1), /voice_memory_limit/);
});

const pid = 4242;
const liveStatus = 'State:\tR (running)\nVmHWM:\t1024 kB\n';
const noPeakStatus = 'State:\tR (running)\n';
const memory = 'MemAvailable:\t900000 kB\n';
const stat = (flags: number, name = 'voice', state = 'R') =>
  `${pid} (${name}) ${state} 1 1 1 0 0 ${flags} 0 0 0 0 0 0 0 0 0 0 1 0 12345\n`;
const ioError = (code: string) => Object.assign(new Error('fixture proc read error'), { code });

function fixture(t: TestContext, status: string | Error, processStat: string | Error = stat(0), host: string | Error = memory) {
  const files = new Map<string, string | Error>([
    [`/proc/${pid}/status`, status], [`/proc/${pid}/stat`, processStat], ['/proc/meminfo', host],
  ]);
  const reads: string[] = [];
  t.mock.method(fs, 'readFile', new Proxy(fs.readFile, {
    apply(target, receiver, args) {
      if (typeof args[0] !== 'string' || !files.has(args[0])) return Reflect.apply(target, receiver, args);
      reads.push(args[0]);
      const value = files.get(args[0])!;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    },
  }));
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const errors: string[] = [];
  const stop = monitorVoiceMemory(pid, error => errors.push(error.code));
  t.after(() => { stop(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return {
    files, reads, errors, stop,
    async tick() {
      t.mock.timers.tick(100);
      await new Promise<void>(resolve => setImmediate(resolve));
    },
  };
}

test('an exiting process can still be R while kernel memory fields are gone', async t => {
  const f = fixture(t, noPeakStatus, stat(4194316));
  await f.tick();
  assert.deepEqual(f.errors, []);
  assert.equal(f.stop(), null);
  assert.ok(f.reads.includes(`/proc/${pid}/stat`));
});

test('exit flag parsing handles spaces and closing parentheses in process names', async t => {
  const f = fixture(t, noPeakStatus, stat(4, 'voice ) worker ('));
  await f.tick();
  assert.deepEqual(f.errors, []);
});

test('exit snapshots preserve the last measured peak rather than inventing zero', async t => {
  const f = fixture(t, liveStatus, stat(4));
  await f.tick();
  f.files.set(`/proc/${pid}/status`, noPeakStatus);
  await f.tick();
  assert.deepEqual(f.errors, []);
  assert.equal(f.stop(), 1024);
});

test('missing fields in a live non-exiting process remain a hard failure', async t => {
  const f = fixture(t, noPeakStatus, stat(4194304));
  await f.tick();
  await f.tick();
  assert.deepEqual(f.errors, ['voice_memory_unknown']);
});

for (const badStat of ['malformed', '4242 (voice) R 1', stat(4).replace('4242', '4243'),
  stat(4).replace(' 4 ', ' NaN ')]) {
  test(`invalid or mismatched proc stat fails closed: ${badStat.trim()}`, async t => {
    const f = fixture(t, noPeakStatus, badStat);
    await f.tick();
    assert.deepEqual(f.errors, ['voice_memory_unknown']);
  });
}

test('missing process during secondary exit check is not a host monitoring failure', async t => {
  const f = fixture(t, noPeakStatus, ioError('ENOENT'));
  await f.tick();
  assert.deepEqual(f.errors, []);
});

test('unreadable process flags do not bypass protection', async t => {
  const f = fixture(t, noPeakStatus, ioError('EACCES'));
  await f.tick();
  assert.deepEqual(f.errors, ['voice_memory_unknown']);
});

test('host meminfo ENOENT cannot be confused with a vanished child', async t => {
  const f = fixture(t, liveStatus, stat(0), ioError('ENOENT'));
  await f.tick();
  assert.deepEqual(f.errors, ['voice_memory_unknown']);
});

test('a vanished process status remains benign', async t => {
  const f = fixture(t, ioError('ENOENT'));
  await f.tick();
  assert.deepEqual(f.errors, []);
});

test('RSS and host-headroom checks still reject live processes', async t => {
  const f = fixture(t, `State:\tR\nVmHWM:\t${VOICE_MAX_RSS_KIB + 1} kB\n`, stat(4));
  await f.tick();
  assert.deepEqual(f.errors, ['voice_memory_limit']);
  assert.ok(!f.reads.includes(`/proc/${pid}/stat`));
});

test('unknown host memory and low host headroom are still enforced', async t => {
  const f = fixture(t, liveStatus, stat(0), 'MemAvailable:\t1 kB\n');
  await f.tick();
  assert.deepEqual(f.errors, ['voice_low_memory']);
});

test('unreadable host memory is not silently accepted', async t => {
  const f = fixture(t, liveStatus, stat(0), 'MemTotal:\t1000000 kB\n');
  await f.tick();
  assert.deepEqual(f.errors, ['voice_memory_unknown']);
});

test('stopping during a pending read cannot report a late failure', async t => {
  const f = fixture(t, noPeakStatus, stat(0));
  t.mock.timers.tick(100);
  f.stop();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.errors, []);
});
