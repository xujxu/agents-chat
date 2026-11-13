import type { UserSession } from '@/lib/acp/types';
import { getAgentProcesses, getBootPromises, getUserSessions } from '@/lib/acp/runtimeState';

export type AgentProcessState = 'running' | 'starting' | 'stopped';
export const AGENT_RESTART_WAIT_MS = 60_000;

export function getAgentProcessState(agentId: string): { processState: AgentProcessState; processError: string | null } {
  const proc = getAgentProcesses().get(agentId);
  const processState: AgentProcessState = proc?.ready ? 'running' : proc?.booting ? 'starting' : 'stopped';
  return { processState, processError: processState === 'stopped' ? proc?.error ?? null : null };
}

/**
 * Kills an agent's process (or relay link) and ends its users' live turns with `reason`,
 * so open chats finish at once instead of waiting for the missing-turn timeout.
 * Sessions are reset, not dropped: the next send boots a fresh process and session/loads each chat's saved session.
 * Returns whether the agent was running or starting.
 */
export function stopAgentRuntime(agentId: string, reason: string, clearPendingUserRequests: (sess: UserSession) => void): boolean {
  const procs = getAgentProcesses();
  const proc = procs.get(agentId);
  procs.delete(agentId);
  getBootPromises().delete(agentId);
  for (const [key, sess] of getUserSessions()) {
    if (!key.startsWith(`${agentId}:`)) continue;
    clearPendingUserRequests(sess);
    for (const turn of sess.activeTurns.values()) {
      if (turn.done) continue;
      turn.done = true;
      turn.phase = 'done';
      turn.error = reason;
      turn.statusText = reason;
    }
    sess.sessionId = null;
    sess.chatSessions.clear();
    sess.phase = 'idle';
  }
  if (!proc) return false;
  const wasRunning = proc.ready || proc.booting;
  const rpc = proc.rpc;
  // Null rpc first so in-flight prompt recovery fails fast instead of writing to the dead process.
  proc.rpc = null;
  proc.ready = false;
  proc.booting = false;
  rpc?.destroy();
  return wasRunning;
}

/** Resolves true once `boot` settles (either way), or false after `ms`; slow agents keep booting in the background. */
export async function settlesWithin(boot: Promise<unknown>, ms = AGENT_RESTART_WAIT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      boot.then(() => true, () => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
