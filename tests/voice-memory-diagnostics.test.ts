import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { monitorVoiceMemory } from '../lib/voice/memory';
import { transcribeVoice } from '../lib/voice/transcriber';

type Observation = {
  caseId: string; state: string | null; statusBytes: number; hasPeak: boolean;
  hasRss: boolean; flags: number | null; statReadError: string | null;
};
type Outcome = { caseId: string; error: string | null; exitCode?: number | null; peakKiB?: number | null };

test('bounded CI diagnosis of real process exits and candidate inference', {
  skip: process.env.VOICE_MEMORY_DIAG !== '1', timeout: 600_000,
}, async t => {
  const readFile = fs.readFile.bind(fs);
  const observations: Observation[] = [];
  const outcomes: Outcome[] = [];
  let caseId = '';
  let statusReads = 0;
  // Observe only proc fields, never command lines, environment, transcripts or raw status.
  t.mock.method(fs, 'readFile', new Proxy(fs.readFile, {
    apply(target, receiver, args) {
      const file = args[0];
      const match = typeof file === 'string' ? /^\/proc\/(\d+)\/status$/.exec(file) : null;
      const pending: Promise<string | Buffer> = Reflect.apply(target, receiver, args);
      if (!match) return pending;
      const currentCase = caseId;
      statusReads++;
      return pending.then(async data => {
        const status = data.toString();
        if (/^VmHWM:\s+\d+\s+kB$/m.test(status)) return data;
        let flags: number | null = null;
        let statReadError: string | null = null;
        try {
          const stat = await readFile(`/proc/${match[1]}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
          if (fields.length > 6 && /^\d+$/.test(fields[6])) flags = Number(fields[6]);
          else statReadError = 'malformed_stat';
        } catch (error) {
          statReadError = error instanceof Error && 'code' in error ? String(error.code) : 'read_failed';
        }
        observations.push({
          caseId: currentCase, state: /^State:\s+(\S)/m.exec(status)?.[1] ?? null,
          statusBytes: Buffer.byteLength(status), hasPeak: /^VmHWM:/m.test(status),
          hasRss: /^VmRSS:/m.test(status), flags, statReadError,
        });
        return data;
      });
    },
  }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await fs.mkdir('diagnostics', { recursive: true });
  const save = async () => {
    await fs.writeFile('diagnostics/observations.json', JSON.stringify({
      statusReads, observations, outcomes,
      note: 'Stat is read only after absent VmHWM, before returning the status to the unchanged guard. Extra IO may alter exit timing.',
    }, null, 2));
  };
  try {
    for (let i = 0; i < 80; i++) {
      caseId = `exit-probe-${i}`;
      const child = spawn(process.execPath, ['-e',
        `const data=Buffer.alloc(24*1024*1024,1); setTimeout(()=>process.exit(data[0]-1),${60 + i % 60});`],
      { stdio: 'ignore' });
      assert.ok(child.pid);
      let failure: string | null = null;
      const stop = monitorVoiceMemory(child.pid, error => { failure = error.code; child.kill('SIGKILL'); });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      outcomes.push({ caseId, error: failure, exitCode, peakKiB: stop() });
    }
    const manifest: Array<{ id: string; dataset: string }> =
      JSON.parse(await fs.readFile('reviewed/samples.json', 'utf8'));
    await fs.mkdir('chain-evidence', { recursive: true });
    const configuration = {
      binary: path.resolve('voice-sense-adapter'), model: path.resolve('sense/model.int8.onnx'),
    };
    for (const sample of manifest.filter(row => row.dataset === 'ASCEND')) {
      caseId = sample.id;
      let failure: string | null = null;
      try {
        await transcribeVoice(await fs.readFile(`short/audio/${sample.id}.wav`), configuration, AbortSignal.timeout(120_000));
      } catch (error) {
        failure = error instanceof Error ? error.message : 'non_error_exception';
        assert.match(failure, /^voice_|^The operation was aborted/);
      }
      outcomes.push({ caseId, error: failure });
      await save();
    }
  } finally {
    await save();
  }
  assert.ok(statusReads > 0, 'The actual production guard must use the observed reader');
  if (process.env.VOICE_MEMORY_EXPECT_FIXED === '1') {
    assert.equal(outcomes.filter(row => row.error === 'voice_memory_unknown').length, 0,
      'Confirmed exit races must no longer produce unknown-memory failures');
    assert.ok(outcomes.some(row => row.error === 'voice_memory_limit'),
      'Real over-budget candidate inputs must still be rejected');
  }
  console.log(JSON.stringify({
    statusReads, missingPeakSnapshots: observations.length,
    missingPeakExitingFlags: observations.filter(row => row.flags !== null && (row.flags & 4) !== 0).length,
    outcomes: outcomes.length,
    errors: outcomes.reduce<Record<string, number>>((counts, row) => {
      const key = row.error ?? 'none';
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
  }));
});
