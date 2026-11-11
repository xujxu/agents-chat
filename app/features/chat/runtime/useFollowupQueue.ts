'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ChatMessage } from '../chatTypes';
import type { ChatAttachment } from '../../composer/attachmentTypes';
import type { ChatSidebarStatus } from '../components/ChatSidebarList';
import type { Agent } from '../../agents/agentTypes';
import { getMentionedAgentIds } from '../chatHelpers';
import type { IncrementalChatSaver } from './incrementalChatSaver';

export type FollowupItem = { id: string; chatId: string; agentId: string; text: string; modelId?: string; version: number; createdAt: number };
type ActiveTurn = { agentId: string; messageId?: string; done: boolean; phase?: string; statusText?: string; fullText?: string };
type AcpResult = { ok?: boolean; error?: string; items?: FollowupItem[]; paused?: boolean; counts?: Record<string, number>; activeTurns?: ActiveTurn[] };

type FollowupRuntime = {
  chatMessagesRef: MutableRefObject<Record<string, ChatMessage[]>>;
  messagesRef: MutableRefObject<ChatMessage[]>;
  currentChatIdRef: MutableRefObject<string>;
  sessionRunsRef: MutableRefObject<Record<string, { agentId: string; chatId?: string }>>;
  runVersion: number;
  isChatRunning: (chatId: string) => boolean;
  setMessagesForChat: (chatId: string, messages: ChatMessage[]) => void;
  chatSaver: Pick<IncrementalChatSaver, 'hydrate'>;
  resumeActiveTurn: (agentId: string, turn: ActiveTurn) => void;
  getChatSidebarStatus: (chatId: string) => ChatSidebarStatus | null;
};

type FollowupQueueOptions = {
  chatId: string;
  runtime: FollowupRuntime;
  acp: (body: Record<string, unknown>) => Promise<unknown>;
  prepareSubmission: () => { text: string; attachments: ChatAttachment[]; onStaged: () => void };
  getModelId: (agentId: string) => string | null | undefined;
  fallbackAgentId: string | null;
  agents: Agent[];
};

const ERROR_TEXT: Record<string, string> = {
  queue_full: 'The follow-up queue is full (20 items).',
  too_long: 'That follow-up is too long.',
  conflict: 'This follow-up changed elsewhere. Reloaded the latest version.',
  missing: 'This follow-up was already sent or removed.',
  turn_in_progress: 'The agent is still working; the queue will be sent when it finishes.',
  multiple_mentions: 'A queued follow-up can address one agent. Send multi-agent requests after the current turn.',
};

export function useFollowupQueue({ chatId, runtime, acp, prepareSubmission, getModelId, fallbackAgentId, agents }: FollowupQueueOptions) {
  const [items, setItems] = useState<FollowupItem[]>([]);
  const [paused, setPaused] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const syncingRef = useRef(new Set<string>());
  const optsRef = useRef({ runtime, acp });
  optsRef.current = { runtime, acp };

  const mergeServerMessages = useCallback(async (targetChatId: string) => {
    const res = await fetch(`/api/chats?id=${encodeURIComponent(targetChatId)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok || !data.chat || chatIdRef.current !== targetChatId) return;
    const rt = optsRef.current.runtime;
    const local = rt.chatMessagesRef.current[targetChatId] || (targetChatId === rt.currentChatIdRef.current ? rt.messagesRef.current : []);
    const localIds = new Set(local.map(message => message.id));
    const missing = ((data.chat.messages || []) as ChatMessage[]).filter(message => !localIds.has(message.id));
    if (!missing.length) return;
    // Record the server copies as saved; otherwise the next autosave re-creates them and conflicts.
    rt.chatSaver.hydrate(targetChatId, missing);
    rt.setMessagesForChat(targetChatId, [...local, ...missing]);
  }, []);

  // A follow-up turn is started by the server after the previous turn ends, so
  // this client may not know about it yet: pull its messages and resume polling.
  const adoptTurns = useCallback(async (targetChatId: string, turns: ActiveTurn[]) => {
    const rt = optsRef.current.runtime;
    for (const turn of turns) {
      if (!turn.messageId || syncingRef.current.has(turn.messageId)) continue;
      const local = rt.chatMessagesRef.current[targetChatId] || rt.messagesRef.current;
      const known = local.some(message => message.id === turn.messageId);
      if (turn.done ? known : rt.isChatRunning(targetChatId)) continue;
      syncingRef.current.add(turn.messageId);
      try {
        await mergeServerMessages(targetChatId);
        if (!turn.done && chatIdRef.current === targetChatId && rt.currentChatIdRef.current === targetChatId && !rt.isChatRunning(targetChatId)) {
          rt.resumeActiveTurn(turn.agentId, turn);
        }
      } catch {
        // Retry on the next refresh.
      } finally {
        syncingRef.current.delete(turn.messageId);
      }
    }
  }, [mergeServerMessages]);

  const refresh = useCallback(async () => {
    const targetChatId = chatIdRef.current;
    const result = await optsRef.current.acp({ action: 'followup-list', chatId: targetChatId }).catch(() => null) as AcpResult | null;
    if (!result?.ok || chatIdRef.current !== targetChatId) return;
    setItems(result.items || []);
    setPaused(Boolean(result.paused));
    setCounts(result.counts || {});
    if (targetChatId && result.activeTurns?.length) await adoptTurns(targetChatId, result.activeTurns);
  }, [adoptTurns]);

  const running = chatId ? runtime.isChatRunning(chatId) : false;
  useEffect(() => {
    setItems([]);
    setPaused(false);
    setError(null);
  }, [chatId]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === 'visible') await refresh();
      if (!stopped) timer = setTimeout(tick, running || items.length > 0 ? 3000 : 10000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [chatId, running, items.length > 0, refresh]);

  const runningAgentId = useCallback(() => {
    const run = Object.values(optsRef.current.runtime.sessionRunsRef.current).find(candidate => candidate.chatId === chatIdRef.current);
    return run?.agentId || items[items.length - 1]?.agentId || fallbackAgentId;
  }, [items, fallbackAgentId]);

  const call = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await optsRef.current.acp(body).catch((err: Error) => ({ ok: false, error: err.message })) as AcpResult;
      if (!result?.ok) setError(ERROR_TEXT[result?.error || ''] || result?.error || 'Follow-up request failed.');
      return Boolean(result?.ok);
    } finally {
      setBusy(false);
      void refresh();
    }
  }, [refresh]);

  const queue = useCallback(async () => {
    const draft = prepareSubmission();
    if (!draft.text || !chatIdRef.current) return;
    if (draft.attachments.length) { setError('Attachments can’t be queued. Send them after the agent finishes.'); return; }
    // An @mention routes the follow-up to that agent, like a normal send; the server starts it right away if that agent is idle.
    const mentioned = getMentionedAgentIds(draft.text, agents);
    if (mentioned.length > 1) { setError(ERROR_TEXT.multiple_mentions); return; }
    const agentId = mentioned[0] || runningAgentId();
    if (!agentId) return;
    if (await call({ action: 'followup-add', agentId, chatId: chatIdRef.current, text: draft.text, modelId: getModelId(agentId) || undefined })) draft.onStaged();
  }, [prepareSubmission, agents, runningAgentId, getModelId, call]);

  const update = useCallback((item: FollowupItem, text: string) => call({ action: 'followup-update', id: item.id, text, version: item.version }), [call]);
  const remove = useCallback((item: FollowupItem) => call({ action: 'followup-remove', id: item.id }), [call]);
  const sendNow = useCallback(async () => {
    const targetChatId = chatIdRef.current;
    const agentIds = [...new Set(items.map(item => item.agentId))];
    if (!agentIds.length) { const agentId = runningAgentId(); if (agentId) agentIds.push(agentId); }
    if (!agentIds.length || !targetChatId) return;
    // Each agent's items become one turn for that agent.
    for (const agentId of agentIds) await call({ action: 'followup-send-now', agentId, chatId: targetChatId });
    setTimeout(() => void refresh(), 1500);
  }, [items, runningAgentId, call, refresh]);

  const getSidebarStatus = useCallback((targetChatId: string): ChatSidebarStatus | null => {
    const status = runtime.getChatSidebarStatus(targetChatId);
    const count = counts[targetChatId] || 0;
    if (!count || status?.kind === 'running') return status;
    return { label: `Queued (${count})`, kind: 'queued' };
  }, [runtime.getChatSidebarStatus, counts]);

  return { items, error, busy, running, paused: paused && !running, queue, update, remove, sendNow, getSidebarStatus, dismissError: () => setError(null) };
}

export type FollowupQueueController = ReturnType<typeof useFollowupQueue>;
