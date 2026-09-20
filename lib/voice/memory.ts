import { readFile } from 'node:fs/promises';
import { VoiceError } from './audio';

export const VOICE_START_MEMORY_KIB = 768 * 1024;
export const VOICE_MIN_FREE_KIB = 256 * 1024;
export const VOICE_MAX_RSS_KIB = 384 * 1024;

export function availableMemoryKiB(info: string): number {
  const match = info.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (!match) throw new VoiceError('voice_memory_unknown', 503);
  return Number(match[1]);
}

export function checkVoiceMemory(availableKiB: number, peakRssKiB?: number) {
  if (peakRssKiB === undefined) {
    if (availableKiB < VOICE_START_MEMORY_KIB) throw new VoiceError('voice_low_memory', 503);
  } else {
    if (availableKiB < VOICE_MIN_FREE_KIB) throw new VoiceError('voice_low_memory', 503);
    if (peakRssKiB > VOICE_MAX_RSS_KIB) throw new VoiceError('voice_memory_limit', 503);
  }
}

export async function assertVoiceMemoryAvailable() {
  checkVoiceMemory(availableMemoryKiB(await readFile('/proc/meminfo', 'utf8')));
}

export function monitorVoiceMemory(pid: number, onFailure: (error: VoiceError) => void) {
  let stopped = false;
  let checking = false;
  let peakRssKiB: number | null = null;
  const timer = setInterval(() => {
    if (stopped || checking) return;
    checking = true;
    void (async () => {
      try {
        const [status, memory] = await Promise.all([
          readFile(`/proc/${pid}/status`, 'utf8'), readFile('/proc/meminfo', 'utf8'),
        ]);
        if (stopped) return;
        if (/^State:\s+[XZ]/m.test(status)) return;
        const peak = status.match(/^VmHWM:\s+(\d+)\s+kB$/m);
        if (!peak) throw new VoiceError('voice_memory_unknown', 503);
        peakRssKiB = Math.max(peakRssKiB ?? 0, Number(peak[1]));
        checkVoiceMemory(availableMemoryKiB(memory), peakRssKiB);
      } catch (error) {
        if (stopped || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return;
        stopped = true;
        clearInterval(timer);
        onFailure(error instanceof VoiceError ? error : new VoiceError('voice_memory_unknown', 503));
      } finally { checking = false; }
    })();
  }, 100);
  return () => {
    stopped = true;
    clearInterval(timer);
    return peakRssKiB;
  };
}
