import type { AgentConfig, AgentProcess, NdjsonRpc, PendingUserRequest, TurnState, UserSession } from './types';

export type PendingUserRequestResponder = {
  rpc: NdjsonRpc;
  rpcRequestId: number | string;
  agentId: string;
  turn: TurnState;
  request: PendingUserRequest;
  method: string;
  createdAt: number;
  timeout?: ReturnType<typeof setTimeout>;
};

export const pendingUserRequestGlobal = globalThis as typeof globalThis & {
  __acpPendingUserRequestResponders?: Map<string, PendingUserRequestResponder>;
};

export function getPendingUserRequestResponders(): Map<string, PendingUserRequestResponder> {
  if (!pendingUserRequestGlobal.__acpPendingUserRequestResponders) {
    pendingUserRequestGlobal.__acpPendingUserRequestResponders = new Map();
  }
  return pendingUserRequestGlobal.__acpPendingUserRequestResponders;
}

export const pendingUserRequestResponders = getPendingUserRequestResponders();

export const globalStore = globalThis as typeof globalThis & {
  __acpAgents?: Map<string, AgentProcess>;
  __acpUserSessions?: Map<string, UserSession>;
  __acpBootPromises?: Map<string, Promise<void>>;
  /** Collects replayed messages during session/load (keyed by sessionId) */
  __acpReplayBuffers?: Map<string, { role: 'user' | 'agent'; text: string }[]>;
};

export function getAgentProcesses(): Map<string, AgentProcess> {
  if (!globalStore.__acpAgents) globalStore.__acpAgents = new Map();
  return globalStore.__acpAgents;
}

export function getUserSessions(): Map<string, UserSession> {
  if (!globalStore.__acpUserSessions) globalStore.__acpUserSessions = new Map();
  return globalStore.__acpUserSessions;
}

// Periodically clean up stale user sessions (inactive > 30 min)
export const STALE_SESSION_MS = 30 * 60_000;
export const PENDING_USER_REQUEST_TIMEOUT_MS = 10 * 60_000;
export function cleanupStaleSessions() {
  const now = Date.now();
  for (const [key, sess] of getUserSessions()) {
    if (now - sess.lastActive > STALE_SESSION_MS && sess.activeTurns.size === 0) {
      getUserSessions().delete(key);
    }
  }
}

export function getBootPromises(): Map<string, Promise<void>> {
  if (!globalStore.__acpBootPromises) globalStore.__acpBootPromises = new Map();
  return globalStore.__acpBootPromises;
}

export function getReplayBuffers(): Map<string, { role: 'user' | 'agent'; text: string }[]> {
  if (!globalStore.__acpReplayBuffers) globalStore.__acpReplayBuffers = new Map();
  return globalStore.__acpReplayBuffers;
}

/**
 * Run session/load once per (process, sessionId). Loading the same session
 * twice makes some agents subscribe twice and emit every update twice, so
 * concurrent callers (e.g. resume-session and send racing after a restart)
 * await the same in-flight load and share its replayed messages.
 */
export function loadSessionOnce(
  proc: AgentProcess,
  sessionId: string,
  buildParams: () => Promise<Record<string, unknown>>,
): Promise<{ role: 'user' | 'agent'; text: string }[]> {
  const loading = proc.loadingSessions ??= new Map();
  const inflight = loading.get(sessionId);
  if (inflight) return inflight;
  const rpc = proc.rpc;
  const promise = Promise.resolve().then(async () => {
    if (!rpc) throw new Error('Agent process not ready');
    const replayBuffers = getReplayBuffers();
    replayBuffers.set(sessionId, []);
    try {
      const params = await buildParams();
      await rpc.send('session/load', { sessionId, ...params });
      proc.knownSessions.add(sessionId);
      return replayBuffers.get(sessionId) || [];
    } finally {
      replayBuffers.delete(sessionId);
      if (loading.get(sessionId) === promise) loading.delete(sessionId);
    }
  });
  loading.set(sessionId, promise);
  return promise;
}

export function userSessionKey(agentId: string, userId: string): string {
  return `${agentId}:${userId}`;
}

export function getAgentProcess(agentId: string, config: AgentConfig): AgentProcess {
  const procs = getAgentProcesses();
  let proc = procs.get(agentId);
  if (!proc) {
    proc = {
      rpc: null,
      ready: false,
      booting: false,
      error: null,
      config,
      cachedCwd: config.cwd || process.cwd(),
      supportsLoadSession: false,
      knownSessions: new Set(),
      availableCommandsBySession: new Map(),
      authMethods: [],
      needsAuth: false,
    };
    procs.set(agentId, proc);
  }
  return proc;
}

export function getUserSession(agentId: string, userId: string): UserSession {
  const sessions = getUserSessions();
  const key = userSessionKey(agentId, userId);
  let sess = sessions.get(key);
  if (!sess) {
    sess = {
      sessionId: null,
      chatSessions: new Map(),
      activeTurns: new Map(),
      alwaysAllowedPermissionSessions: new Set(),
      phase: 'idle',
      turnCount: 0,
      lastActive: Date.now(),
    };
    sessions.set(key, sess);
  }
  sess.lastActive = Date.now();
  // Ensure chatSessions and activeTurns exist for sessions created before these fields were added
  if (!sess.chatSessions) sess.chatSessions = new Map();
  if (!sess.activeTurns) sess.activeTurns = new Map();
  if (!sess.alwaysAllowedPermissionSessions) sess.alwaysAllowedPermissionSessions = new Set();
  // Migrate legacy activeTurn to activeTurns map
  if ((sess as any).activeTurn) {
    const legacyTurn = (sess as any).activeTurn as TurnState;
    const key = legacyTurn.chatId || '__default';
    sess.activeTurns.set(key, legacyTurn);
    delete (sess as any).activeTurn;
  }
  return sess;
}
