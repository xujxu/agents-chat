import type { ChatMessage, ContentPart } from '../chatTypes';

export type TurnEvent = {
  type: string; ts?: number; toolName?: string; toolCallId?: string;
  toolArgs?: string; toolResult?: string; toolResultTruncated?: boolean; text?: string;
};

function samePart(a: ContentPart, b: ContentPart): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tool' && b.kind === 'tool') {
    return a.toolName === b.toolName && a.args === b.args && a.result === b.result
      && a.resultTruncated === b.resultTruncated && a.done === b.done;
  }
  return (a as { text: string }).text === (b as { text: string }).text;
}

/**
 * Builds message parts from a turn's event log. Parts equal to the previous poll's are returned
 * as the same objects (and the same array when nothing changed) so memoized rendering skips them.
 */
export function buildTurnParts(events: TurnEvent[] | undefined, previous?: ContentPart[]): ContentPart[] {
  const parts: ContentPart[] = [];
  const toolMap = new Map<string, ContentPart & { kind: 'tool' }>();
  for (const evt of events || []) {
    if (evt.type === 'thinking' && evt.text) {
      const last = parts[parts.length - 1];
      if (last && last.kind === 'thinking') { last.text += evt.text; } else { parts.push({ kind: 'thinking', text: evt.text }); }
    } else if (evt.type === 'tool_start' && evt.toolName) {
      const tp: ContentPart & { kind: 'tool' } = { kind: 'tool', toolName: evt.toolName, args: evt.toolArgs, done: false };
      if (evt.toolCallId) toolMap.set(evt.toolCallId, tp);
      parts.push(tp);
    } else if (evt.type === 'tool_complete') {
      const existingTool = evt.toolCallId ? toolMap.get(evt.toolCallId) : null;
      const truncated = evt.toolResultTruncated === undefined ? {} : { resultTruncated: evt.toolResultTruncated };
      if (existingTool) { Object.assign(existingTool, { result: evt.toolResult, done: true }, truncated); }
      else { parts.push({ kind: 'tool', toolName: evt.toolName || 'tool', result: evt.toolResult, ...truncated, done: true }); }
    } else if (evt.type === 'user_response' && evt.text) {
      parts.push({ kind: 'user_answer', text: evt.text });
    } else if (evt.type === 'text_chunk' && evt.text) {
      const last = parts[parts.length - 1];
      if (last && last.kind === 'text') { last.text += evt.text; } else { parts.push({ kind: 'text', text: evt.text }); }
    }
  }
  if (!previous?.length) return parts;
  let unchanged = parts.length === previous.length;
  for (let i = 0; i < parts.length; i++) {
    if (i < previous.length && samePart(parts[i], previous[i])) parts[i] = previous[i];
    else unchanged = false;
  }
  return unchanged ? previous : parts;
}

/** True when applying `patch` would not change `message` (parts compared by identity, userRequest by value). */
export function isNoopMessagePatch(message: ChatMessage, patch: Partial<ChatMessage>): boolean {
  for (const key of Object.keys(patch) as (keyof ChatMessage)[]) {
    const next = patch[key];
    const prev = message[key];
    if (next === prev) continue;
    if (key === 'userRequest' && next && prev && JSON.stringify(next) === JSON.stringify(prev)) continue;
    return false;
  }
  return true;
}
