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

async function readProcessFile(pid: number, name: 'status' | 'stat'): Promise<string | null> {
  try {
    return await readFile(`/proc/${pid}/${name}`, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function isExitingProcess(pid: number, stat: string): boolean {
  const end = stat.lastIndexOf(') ');
  if (!stat.startsWith(`${pid} (`) || end < 0) throw new VoiceError('voice_memory_unknown', 503);
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[6])) {
    throw new VoiceError('voice_memory_unknown', 503);
  }
  const flags = Number(fields[6]);
  if (!Number.isSafeInteger(flags)) throw new VoiceError('voice_memory_unknown', 503);
  // Linux PF_EXITING can precede zombie state and removal of the proc entry.
  return /^[XZ]$/.test(fields[0]) || (flags & 0x4) !== 0;
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
        const status = await readProcessFile(pid, 'status');
        if (stopped || status === null) return;
        if (/^State:\s+[XZ]/m.test(status)) return;
        const peak = status.match(/^VmHWM:\s+(\d+)\s+kB$/m);
        if (!peak) {
          const stat = await readProcessFile(pid, 'stat');
          if (stopped || stat === null || isExitingProcess(pid, stat)) return;
          throw new VoiceError('voice_memory_unknown', 503);
        }
        const memory = await readFile('/proc/meminfo', 'utf8');
        if (stopped) return;
        peakRssKiB = Math.max(peakRssKiB ?? 0, Number(peak[1]));
        checkVoiceMemory(availableMemoryKiB(memory), peakRssKiB);
      } catch (error) {
        if (stopped) return;
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
