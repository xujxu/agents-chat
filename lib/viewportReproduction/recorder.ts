import type { MinimalViewportLog, MinimalViewportSample } from './schema.ts';

export type MinimalSeed = Omit<MinimalViewportLog, 'samples' | 'dropped' | 'stopReason'>;
export type MinimalSnapshot = { log: MinimalViewportLog; body: string };

// Serialized into the isolated document; keep runtime dependencies inside this function.
export function createMinimalRecorder(input: MinimalSeed) {
  const seed = structuredClone(input);
  const samples: MinimalViewportSample[] = [];
  let dropped = 0;
  let finished: MinimalSnapshot | null = null;
  return {
    record(sample: MinimalViewportSample): void {
      if (finished) return;
      samples.push(structuredClone(sample));
      if (samples.length > 255) {
        samples.shift();
        dropped++;
      }
    },
    finish(reason: MinimalViewportLog['stopReason']): MinimalSnapshot {
      if (finished) return finished;
      const log: MinimalViewportLog = { ...seed, samples: [...samples], dropped, stopReason: reason };
      let body = JSON.stringify(log);
      while (new TextEncoder().encode(body).length > 256 * 1024 && log.samples.length > 1) {
        log.samples.shift();
        log.dropped++;
        body = JSON.stringify(log);
      }
      if (new TextEncoder().encode(body).length > 256 * 1024) {
        throw new Error('Diagnostic log exceeds 256 KiB.');
      }
      finished = { log, body };
      return finished;
    },
  };
}
