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
  /** Agents explicitly stopped by an owner/admin; page-load warmup leaves them stopped. */
  __acpStoppedAgents?: Set<string>;
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

export function getStoppedAgents(): Set<string> {
  if (!globalStore.__acpStoppedAgents) globalStore.__acpStoppedAgents = new Set();
  return globalStore.__acpStoppedAgents;
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
  const rpc = proc.rpc;
  const inflight = loading.get(sessionId);
  // A load started on a connection that has since died (agent restart) may
  // stay pending until its RPC timeout; never let new callers join it.
  if (inflight && inflight.rpc === rpc) return inflight.promise;
  const promise = Promise.resolve().then(async () => {
    if (!rpc) throw new Error('Agent process not ready');
    const replayBuffers = getReplayBuffers();
    const buffer: { role: 'user' | 'agent'; text: string }[] = [];
    replayBuffers.set(sessionId, buffer);
    try {
      const params = await buildParams();
      await rpc.send('session/load', { sessionId, ...params });
      if (proc.rpc === rpc) proc.knownSessions.add(sessionId);
      return buffer;
    } finally {
      if (replayBuffers.get(sessionId) === buffer) replayBuffers.delete(sessionId);
      if (loading.get(sessionId)?.promise === promise) loading.delete(sessionId);
    }
  });
  loading.set(sessionId, { rpc, promise });
  return promise;
}

/**
 * Resolves once the session's previous session/prompt on this connection is
 * answered (or after maxWaitMs), or returns null when none is pending. A
 * cancelled prompt can take seconds to unwind; until it does, its late
 * updates are indistinguishable from the next prompt's, so callers hold the
 * next prompt (and its updates) back until then.
 */
export function waitForPriorPrompt(proc: AgentProcess, sessionId: string | null | undefined, maxWaitMs: number): Promise<void> | null {
  const prior = sessionId ? proc.promptsInFlight?.get(sessionId) : undefined;
  if (!prior || prior.rpc !== proc.rpc) return null;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, maxWaitMs);
    void prior.promise.then(() => { clearTimeout(timer); resolve(); });
  });
}

/** Records `settled` as the session's in-flight prompt until it resolves or rejects. */
export function trackPromptInFlight(proc: AgentProcess, sessionId: string | null | undefined, settled: Promise<unknown>): void {
  if (!sessionId) return;
  const inFlight = proc.promptsInFlight ??= new Map();
  const promise = settled.then(() => undefined, () => undefined);
  inFlight.set(sessionId, { rpc: proc.rpc, promise });
  void promise.then(() => {
    if (inFlight.get(sessionId)?.promise === promise) inFlight.delete(sessionId);
  });
}

/**
 * Sends the turn's session/prompt once the session's previous prompt is
 * answered, dropping the turn's updates meanwhile (`awaitingPrior`). A turn
 * interrupted while waiting is never sent.
 */
export function sendPromptAfterPrior(proc: AgentProcess, turn: TurnState, prompt: unknown[], maxWaitMs: number): Promise<Record<string, unknown> | undefined> {
  const prior = waitForPriorPrompt(proc, turn.sessionId, maxWaitMs);
  if (prior) Object.assign(turn, { awaitingPrior: true, statusText: 'Stopping the previous reply' });
  const answered = (prior ?? Promise.resolve()).then(() => {
    if (turn.awaitingPrior) Object.assign(turn, { awaitingPrior: false, statusText: turn.done ? turn.statusText : 'Thinking' });
    if (turn.done) return { stopReason: 'cancelled' };
    if (!proc.rpc) throw new Error('Agent process not ready');
    return proc.rpc.send('session/prompt', { sessionId: turn.sessionId, prompt });
  });
  trackPromptInFlight(proc, turn.sessionId, answered);
  return answered;
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
