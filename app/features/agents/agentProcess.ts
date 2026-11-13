export type AgentProcessInfo = {
  state: 'running' | 'starting' | 'stopped';
  error: string | null;
};

export type AgentProcessOp = 'stop' | 'restart';

export function readProcessInfo(data: any): AgentProcessInfo | null {
  const state = data?.processState;
  if (state !== 'running' && state !== 'starting' && state !== 'stopped') return null;
  return { state, error: typeof data?.processError === 'string' ? data.processError : null };
}

/** Restart on a stopped agent is presented as Start. */
export function processActionVerb(op: AgentProcessOp, current: AgentProcessInfo | null): 'Stop' | 'Start' | 'Restart' {
  if (op === 'stop') return 'Stop';
  return current?.state === 'stopped' ? 'Start' : 'Restart';
}

export function processResultMessage(op: AgentProcessOp, verb: string, agentName: string, info: AgentProcessInfo | null): string {
  if (op === 'stop') return `⏹️ Agent "${agentName}" stopped`;
  const done = info?.state === 'running' ? (verb === 'Start' ? 'started' : 'restarted') : 'starting...';
  return `🔄 Agent "${agentName}" ${done}`;
}
