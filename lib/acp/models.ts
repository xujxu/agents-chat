import * as configStore from '@/lib/configStore';
import type { AgentConfig, AgentModel, AgentProcess } from './types';
import { getAgentProcesses } from './runtimeState';
import { createLogger } from '@/lib/logger';

const logger = createLogger('acp.models');

const log = (...args: unknown[]) => {
  if (args.length === 0) return;
  const [first, ...rest] = args;
  if (rest.length === 0) {
    logger.info(typeof first === 'string' ? first : { value: first }, typeof first === 'string' ? undefined : 'log');
    return;
  }
  const parts = args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()));
  logger.info(parts.join(' '));
};

const MODEL_REFRESH_MS = 10 * 60_000;
const modelsCheckedAt = new Map<string, number>();
const modelRefreshes = new Map<string, Promise<AgentModel[]>>();

export function normalizeSessionModels(input: unknown): AgentModel[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const models: AgentModel[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    models.push({
      modelId,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    });
  }
  return models;
}

export function syncAgentModelsFromSessionResult(agentId: string, sessionResult: unknown): { models: AgentModel[]; defaultModelId: string } | null {
  const session = sessionResult && typeof sessionResult === 'object' ? sessionResult as Record<string, any> : null;
  const modelState = session?.models && typeof session.models === 'object' ? session.models as Record<string, unknown> : null;
  const availableModels = normalizeSessionModels(modelState?.availableModels);
  if (availableModels.length === 0) return null;
  const currentModelId = typeof modelState?.currentModelId === 'string' ? modelState.currentModelId.trim() : '';
  const defaultModelId = currentModelId && availableModels.some(model => model.modelId === currentModelId)
    ? currentModelId
    : availableModels[0].modelId;
  configStore.updateAgent(agentId, { models: availableModels, defaultModelId });
  const proc = getAgentProcesses().get(agentId);
  if (proc) {
    proc.config = { ...proc.config, models: availableModels, defaultModelId };
  }
  modelsCheckedAt.set(agentId, Date.now());
  log(`[ACP:${agentId}] Synced ${availableModels.length} model(s) from session/new; default=${defaultModelId}`);
  return { models: availableModels, defaultModelId };
}

/**
 * The agent's model list as it reports it now. The saved list is only updated when a session is
 * created, so it goes stale while chats keep resuming old sessions; past MODEL_REFRESH_MS this asks
 * the running agent again with a throwaway session. Never boots a stopped agent.
 */
export function refreshAgentModels(proc: AgentProcess, agentId: string): Promise<AgentModel[]> {
  const saved = () => configStore.getAgentById(agentId)?.models || proc.config.models || [];
  const rpc = proc.rpc;
  if (!proc.ready || !rpc || Date.now() - (modelsCheckedAt.get(agentId) || 0) < MODEL_REFRESH_MS) {
    return modelRefreshes.get(agentId) || Promise.resolve(saved());
  }
  modelsCheckedAt.set(agentId, Date.now());
  const refresh = (async () => {
    const probe = await rpc.send('session/new', { cwd: proc.cachedCwd, mcpServers: [] });
    if (probe?.sessionId) rpc.send('session/close', { sessionId: probe.sessionId }).catch(() => { /* ignore if unsupported */ });
    syncAgentModelsFromSessionResult(agentId, probe);
    return saved();
  })().catch((err) => {
    log(`[ACP:${agentId}] Model list refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    return saved();
  }).finally(() => modelRefreshes.delete(agentId));
  modelRefreshes.set(agentId, refresh);
  return refresh;
}

export function validateRequestedModel(config: AgentConfig, requested: unknown): string | undefined {
  const modelId = typeof requested === 'string' ? requested.trim() : '';
  if (!modelId) return undefined;
  const models = config.models || [];
  if (models.length > 0 && !models.some(model => model.modelId === modelId)) {
    throw new Error(`Unknown modelId "${modelId}" for agent "${config.id}"`);
  }
  return modelId;
}

function hasCustomEnv(config: AgentConfig): boolean {
  try {
    const env = config.env ? JSON.parse(config.env) : null;
    return !!env && typeof env === 'object' && Object.keys(env).length > 0;
  } catch {
    return false;
  }
}

export async function applySessionModelIfRequested(proc: AgentProcess, sessionId: string | null, requestedModelId: string | undefined): Promise<void> {
  if (!requestedModelId) return;
  const defaultId = proc.config.defaultModelId || (proc.config.models?.[0]?.modelId);
  const isDefault = requestedModelId === defaultId;
  // Agents with custom env (e.g. Claude Code behind a proxy) may translate session/set_model to a
  // model name the proxy doesn't recognize, so leave them on their default. Other agents get an
  // explicit set_model even for the default: the model reported by session/new is not always the
  // one the session runs (Copilot CLI can switch to its own startup model right after session/new).
  if (isDefault && hasCustomEnv(proc.config)) return;
  if (!sessionId) throw new Error('Cannot set model before session is created');
  if (!proc.rpc) throw new Error('Agent process not ready');
  log(`[ACP:${proc.config.id}] session/set_model modelId="${requestedModelId}" (default="${defaultId}") session=${sessionId}`);
  try {
    await proc.rpc.send('session/set_model', { sessionId, modelId: requestedModelId });
  } catch (firstErr: any) {
    const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    try {
      await proc.rpc.send('unstable_setSessionModel', { sessionId, modelId: requestedModelId });
    } catch (secondErr: any) {
      const secondMsg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      const message = `Agent does not support switching to model "${requestedModelId}" for this session (${firstMsg}; ${secondMsg})`;
      // Keep the old behaviour (no switch, no error) for agents that can't set their default model,
      // but still surface a missing session so the caller can recover it.
      if (isDefault && !/session[\s\S]*not found|not found:\s*session/i.test(`${firstMsg} ${secondMsg}`)) {
        log(`[ACP:${proc.config.id}] ${message}; continuing with the agent's default`);
        return;
      }
      throw new Error(message);
    }
  }
}
