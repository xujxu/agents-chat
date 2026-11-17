/**
 * Copilot CLI streams its sub-agents' thoughts and replies on the parent session, tagged with
 * `_meta["github.com/copilot"].agentId`. They are not part of the parent's reply (the parent reads
 * them back with read_agent), so appending them would splice the sub-agent's text into the reply.
 */
export function isSubagentUpdate(update: unknown): boolean {
  const meta = (update as { _meta?: Record<string, unknown> } | null | undefined)?._meta?.['github.com/copilot'];
  const agentId = meta && typeof meta === 'object' ? (meta as { agentId?: unknown }).agentId : undefined;
  return typeof agentId === 'string' && agentId.length > 0;
}
