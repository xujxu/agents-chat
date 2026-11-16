import type { MutableRefObject } from 'react';
import type { Agent } from '../../agents/agentTypes';
import type { ChatAttachment } from '../../composer/attachmentTypes';
import type { AgentUserRequest, ChatMessage, OrchestrationState, SessionRunContext } from '../chatTypes';
import { mapTurnPhase, makeId, PromptSendFailedError } from './chatRunLoop';
import { applyPolledTurnEvents, buildTurnParts, isNoopMessagePatch, type TurnEvent, type TurnEventLog } from './turnParts';
import { looksLikeQuestion } from '../../orchestration/workflowFollowUp';

export type FileCommentCallbacks = {
  extractFileComments: (text: string, agentId: string) => { cleanText: string; comments: any[] };
  saveAgentComments: (agentId: string, comments: any[], agentName?: string) => Promise<void>;
  fileCommentsRef: MutableRefObject<any[]>;
  resolveProcessingCommentForChat: (chatId: string, commentId: string) => Promise<void>;
};

export type AcpServiceContext = {
  acp: (body: Record<string, unknown>) => Promise<any>;
  sessionRunsRef: MutableRefObject<Record<string, SessionRunContext>>;
  orchestrationsRef: MutableRefObject<Record<string, OrchestrationState>>;
  currentChatIdRef: MutableRefObject<string>;
  currentAgentSessionsRef: MutableRefObject<Record<string, string>>;
  needsContextRestoreRef: MutableRefObject<boolean>;
  chatMessagesRef: MutableRefObject<Record<string, ChatMessage[]>>;
  messagesRef: MutableRefObject<ChatMessage[]>;
  agentsRef: MutableRefObject<Agent[]>;
  getSelectedModelIdForAgent: (agentId: string) => string;
  updateMessage: (id: string, patch: Partial<ChatMessage>, chatId?: string) => void;
  addMessage: (msg: Omit<ChatMessage, 'id' | 'ts'> & { id?: string; ts?: number }, chatId?: string) => string;
  removeMessage: (id: string, chatId?: string) => void;
  notifyRunStateChanged: () => void;
  maybeAdvanceOrchestration: (orchestrationId: string) => Promise<void>;
  onRunFinalized?: (chatId: string) => void;
  fileCommentCallbacksRef: MutableRefObject<FileCommentCallbacks | null>;
  /** Loads the server's saved copy of a message; null when unavailable. */
  fetchServerMessage?: (chatId: string, messageId: string) => Promise<ChatMessage | null>;
  /** Records a message applied from the server as already saved. */
  onServerMessageApplied?: (chatId: string, message: ChatMessage) => void;
};

const RECONNECTING_STATUS = 'Reconnecting…';

/** Sleeps for `ms`, waking early when the browser comes back online or the tab becomes visible. */
function waitForRetry(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') { setTimeout(resolve, ms); return; }
    const onVisible = () => { if (document.visibilityState === 'visible') done(); };
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      document.removeEventListener('visibilitychange', onVisible);
      resolve();
    };
    const timer = setTimeout(done, ms);
    window.addEventListener('online', done);
    document.addEventListener('visibilitychange', onVisible);
  });
}

export function createAcpHandlers(ctx: AcpServiceContext) {
  function isChatRunning(chatId: string) {
    return Object.values(ctx.sessionRunsRef.current).some((run) => run.chatId === chatId);
  }

  function finalizeRun(runKey: string, finalStatusText?: string) {
    const run = ctx.sessionRunsRef.current[runKey];
    if (!run) return;
    ctx.updateMessage(run.pendingId, { pending: false, statusText: finalStatusText, ptyPhase: undefined }, run.chatId);
    const orchestration = ctx.orchestrationsRef.current[run.orchestrationId];
    if (orchestration && run.kind === 'worker') {
      orchestration.results[run.agentId] = run.currentText || '';
      if (run.workflowNodeId) {
        orchestration.results[run.workflowNodeId] = run.currentText || '';
        if (!orchestration.nodeStatuses) orchestration.nodeStatuses = {};
        const text = run.currentText || '';
        let nextStatus: 'failed' | 'awaiting-input' | 'ok';
        if (text.startsWith('⚠️')) nextStatus = 'failed';
        else if (looksLikeQuestion(text)) nextStatus = 'awaiting-input';
        else nextStatus = 'ok';
        orchestration.nodeStatuses[run.workflowNodeId] = nextStatus;
      }
    }
    delete ctx.sessionRunsRef.current[runKey];
    ctx.notifyRunStateChanged();
    ctx.onRunFinalized?.(run.chatId);
    if (orchestration && run.kind === 'worker') {
      void ctx.maybeAdvanceOrchestration(run.orchestrationId);
    }
  }

  function resumeActiveTurn(
    agentId: string,
    turn: { messageId?: string; fullText?: string; phase?: string; statusText?: string; userRequest?: AgentUserRequest },
  ) {
    const resumeChatId = ctx.currentChatIdRef.current;
    const pendingId = turn.messageId || `pending-${makeId()}`;
    const existing = (ctx.chatMessagesRef.current[resumeChatId] || ctx.messagesRef.current).find((m) => m.id === pendingId);
    const statusText = turn.statusText || existing?.statusText || 'Thinking';
    const ptyPhase = mapTurnPhase(turn.phase || (existing?.ptyPhase as string) || 'thinking');
    const userRequest = turn.userRequest || existing?.userRequest;
    if (existing) {
      ctx.updateMessage(pendingId, { pending: true, agentId, content: turn.fullText || existing.content || '', statusText, ptyPhase, userRequest }, resumeChatId);
    } else {
      ctx.addMessage({ id: pendingId, type: 'agent', content: turn.fullText || '', agentId, pending: true, statusText, ptyPhase, userRequest }, resumeChatId);
    }
    const runKey = `acp:${agentId}:${resumeChatId}`;
    if (!ctx.sessionRunsRef.current[runKey]) {
      // If a workflow node is persisted as 'running' for this (agent, chat),
      // bind the resumed turn back to it so finalizeRun updates the correct
      // node and maybeAdvanceOrchestration fires dependents on completion.
      let resumedOrchestrationId: string | null = null;
      let resumedWorkflowNodeId: string | undefined;
      for (const orch of Object.values(ctx.orchestrationsRef.current)) {
        if (orch.mode !== 'workflow' || !orch.workflowPlan) continue;
        if (orch.sourceChatId && orch.sourceChatId !== resumeChatId) continue;
        const statuses = orch.nodeStatuses || {};
        const node = orch.workflowPlan.nodes.find(
          (n) => n.agent === agentId && statuses[n.id] === 'running',
        );
        if (node) {
          resumedOrchestrationId = orch.id;
          resumedWorkflowNodeId = node.id;
          break;
        }
      }
      ctx.sessionRunsRef.current[runKey] = {
        agentId,
        pendingId,
        orchestrationId: resumedOrchestrationId ?? `orch-resume-${makeId()}`,
        kind: 'worker',
        currentText: turn.fullText || '',
        chatId: resumeChatId,
        workflowNodeId: resumedWorkflowNodeId,
      };
      ctx.notifyRunStateChanged();
      void pollAcpAgent(agentId, resumeChatId);
    }
  }

  async function sendAcpPrompt(
    runKey: string,
    agentId: string,
    pendingId: string,
    content: string,
    promptAttachments: ChatAttachment[] = [],
  ) {
    const run = ctx.sessionRunsRef.current[runKey];
    if (!run || run.ptySendStarted) return false;
    run.ptySendStarted = true;
    ctx.updateMessage(pendingId, { statusText: 'Connecting', pending: true, ptyPhase: 'loading-environment' }, run.chatId);
    const sendChatId = run.chatId;
    const sendBody: Record<string, unknown> = {
      action: 'send', agentId, text: content, chatId: sendChatId, messageId: pendingId,
    };
    const pendingMessage = (ctx.chatMessagesRef.current[sendChatId]
      || (sendChatId === ctx.currentChatIdRef.current ? ctx.messagesRef.current : []))
      .find((m) => m.id === pendingId);
    if (pendingMessage?.ts) sendBody.messageTs = pendingMessage.ts;
    sendBody.modelId = ctx.getSelectedModelIdForAgent(agentId);
    if (promptAttachments.length > 0) sendBody.attachments = promptAttachments;
    if (ctx.needsContextRestoreRef.current) {
      const historyMessages = ctx.chatMessagesRef.current[sendChatId]
        || (sendChatId === ctx.currentChatIdRef.current ? ctx.messagesRef.current : []);
      sendBody.chatHistory = historyMessages
        .filter((m) => m.type === 'user' || m.type === 'agent')
        .slice(-20)
        .map((m) => ({ type: m.type, content: m.content, agentId: m.agentId }));
      ctx.needsContextRestoreRef.current = false;
    }
    const sendResult = await ctx.acp(sendBody);
    const current = ctx.sessionRunsRef.current[runKey];
    if (!current) return false;
    if (sendResult && !sendResult.ok) {
      throw new PromptSendFailedError(sendResult.error || 'Failed to send prompt to agent');
    }
    if (sendResult?.sessionId) {
      ctx.currentAgentSessionsRef.current = { ...ctx.currentAgentSessionsRef.current, [agentId]: sendResult.sessionId };
    }
    current.ptyTurnId = sendResult?.turn?.id;
    if (sendResult?.phase === 'booting') {
      ctx.updateMessage(pendingId, { statusText: 'Starting environment', ptyPhase: 'loading-environment', pending: true }, sendChatId);
    }
    void pollAcpAgent(agentId, sendChatId);
    return true;
  }

  async function dispatchToAgent(
    agentId: string,
    content: string,
    orchestrationId: string,
    kind: 'worker' | 'summary' = 'worker',
    options?: { round?: number; relation?: string; summary?: boolean; chatId?: string; commentId?: string; attachments?: ChatAttachment[]; workflowNodeId?: string },
  ): Promise<string> {
    const dispatchChatId = options?.chatId || ctx.currentChatIdRef.current;
    const pendingId = `pending-${makeId()}`;
    const runKey = `acp:${agentId}:${dispatchChatId}`;
    if (ctx.sessionRunsRef.current[runKey]) {
      throw new PromptSendFailedError('Agent is already running in this chat');
    }
    ctx.addMessage({
      id: pendingId, type: 'agent', content: '', agentId, pending: true,
      round: options?.round, relation: options?.relation, summary: options?.summary,
    }, dispatchChatId);
    ctx.sessionRunsRef.current[runKey] = {
      agentId, pendingId, orchestrationId, kind,
      currentText: '', chatId: dispatchChatId,
      commentId: options?.commentId, round: options?.round, relation: options?.relation,
      workflowNodeId: options?.workflowNodeId,
    };
    ctx.notifyRunStateChanged();
    try {
      const sent = await sendAcpPrompt(runKey, agentId, pendingId, content, options?.attachments || []);
      if (!sent) throw new Error('Failed to send prompt to agent');
      return runKey;
    } catch (err) {
      ctx.removeMessage(pendingId, dispatchChatId);
      delete ctx.sessionRunsRef.current[runKey];
      ctx.notifyRunStateChanged();
      throw err;
    }
  }

  /** Saves file comments the agent embedded in a finished reply and returns the reply without them. */
  function takeFileComments(text: string, agentId: string): string {
    const fcCbs = ctx.fileCommentCallbacksRef.current;
    if (!fcCbs) return text;
    const { cleanText, comments: agentComments } = fcCbs.extractFileComments(text, agentId);
    if (agentComments.length === 0) return text;
    const agentName = ctx.agentsRef.current.find((a) => a.id === agentId)?.name;
    void fcCbs.saveAgentComments(agentId, agentComments, agentName);
    return cleanText;
  }

  /** Finalizes a run whose reply completed and resolves the file comment it was answering. */
  function completeRun(runKey: string, chatId: string, finalStatusText?: string) {
    const completedCommentId = ctx.sessionRunsRef.current[runKey]?.commentId;
    finalizeRun(runKey, finalStatusText);
    const fcCbs = ctx.fileCommentCallbacksRef.current;
    if (chatId && fcCbs) {
      const fallbackCommentId = fcCbs.fileCommentsRef.current.find(
        (c: any) => c.linkedChatId === chatId && c.status === 'processing',
      )?.id;
      const commentIdToResolve = completedCommentId || fallbackCommentId;
      if (commentIdToResolve) void fcCbs.resolveProcessingCommentForChat(chatId, commentIdToResolve);
    }
  }

  /**
   * Finishes the run from the server's saved reply once the server has finished it. The server
   * keeps writing the reply while this tab is offline or asleep, so its copy is the complete one.
   */
  async function recoverServerReply(runKey: string, chatId: string): Promise<boolean> {
    const current = ctx.sessionRunsRef.current[runKey];
    if (!current || !ctx.fetchServerMessage) return false;
    let saved: ChatMessage | null = null;
    try {
      saved = await ctx.fetchServerMessage(chatId, current.pendingId);
    } catch {
      return false;
    }
    if (!saved || saved.type !== 'agent' || saved.pending !== false) return false;
    if (ctx.sessionRunsRef.current[runKey] !== current) return false;
    current.currentText = takeFileComments((saved.content || '').trim(), current.agentId);
    const patch: Partial<ChatMessage> = {
      content: current.currentText, pending: false, userRequest: undefined,
      version: saved.version, serverManaged: saved.serverManaged, cutOff: saved.cutOff,
    };
    if (saved.parts?.length) patch.parts = saved.parts;
    ctx.updateMessage(current.pendingId, patch, chatId);
    ctx.onServerMessageApplied?.(chatId, saved);
    // A reply cut off by a server restart never answered the file comment it was working on.
    if (saved.cutOff) finalizeRun(runKey, saved.statusText);
    else completeRun(runKey, chatId, saved.statusText);
    return true;
  }

  async function pollAcpAgent(agentId: string, chatId?: string) {
    const effectiveChatId = chatId || ctx.currentChatIdRef.current;
    const runKey = `acp:${agentId}:${effectiveChatId}`;
    let consecutiveErrors = 0;
    const RECONNECTING_AFTER_ERRORS = 3;
    const MAX_RETRY_DELAY = 15_000;
    // Only a turn the server no longer reports can time out; a live turn may legitimately stay
    // silent for a long time (e.g. while the agent waits on a long-running shell command).
    const MISSING_TURN_TIMEOUT = 10 * 60_000;
    const SERVER_COPY_CHECK_INTERVAL = 15_000;
    let lastSeenTurnAt = Date.now();
    // Events already received for the current turn; later polls ask only for what follows.
    let eventLog: TurnEventLog = { events: [] };
    let lastServerCopyCheckAt = 0;
    // A missing turn is only suspicious once this run has seen one or lost the connection.
    let expectTurn = false;
    let statusBeforeReconnect: string | undefined;
    const shownMessage = (id: string) => (ctx.chatMessagesRef.current[effectiveChatId] || []).find((m) => m.id === id);

    while (ctx.sessionRunsRef.current[runKey]) {
      const current = ctx.sessionRunsRef.current[runKey];
      if (!current) break;
      let result: any;
      try {
        result = await ctx.acp({
          action: 'poll', agentId, chatId: effectiveChatId,
          ...(eventLog.turnId ? { turnId: eventLog.turnId, sinceEvent: eventLog.events.length } : {}),
        });
      } catch {
        // Keep retrying: the server finishes the turn without us, so giving up would only hide its reply.
        consecutiveErrors++;
        if (consecutiveErrors === RECONNECTING_AFTER_ERRORS) {
          statusBeforeReconnect = shownMessage(current.pendingId)?.statusText;
          ctx.updateMessage(current.pendingId, { statusText: RECONNECTING_STATUS }, effectiveChatId);
        }
        await waitForRetry(Math.min(1000 * consecutiveErrors, MAX_RETRY_DELAY));
        continue;
      }
      if (consecutiveErrors > 0) {
        // Time spent offline says nothing about whether the server still has the turn.
        lastSeenTurnAt = Date.now();
        expectTurn = true;
        if (consecutiveErrors >= RECONNECTING_AFTER_ERRORS && shownMessage(current.pendingId)?.statusText === RECONNECTING_STATUS) {
          ctx.updateMessage(current.pendingId, { statusText: statusBeforeReconnect }, effectiveChatId);
        }
        consecutiveErrors = 0;
      }

      const turn = result?.activeTurn as {
        id?: string; messageId?: string; fullText?: string; done?: boolean; phase?: string; statusText?: string; error?: string;
        userRequest?: AgentUserRequest;
        events?: TurnEvent[]; eventsFrom?: number; totalEvents?: number;
      } | null;

      if (turn?.messageId && turn.messageId !== current.pendingId) {
        // The server already moved on (e.g. queued follow-ups); its persisted copy of this reply is authoritative.
        if (await recoverServerReply(runKey, effectiveChatId)) return;
        if (ctx.sessionRunsRef.current[runKey] !== current) return;
        ctx.updateMessage(current.pendingId, { content: current.currentText || '', pending: false, userRequest: undefined }, effectiveChatId);
        finalizeRun(runKey);
        return;
      }
      if (turn) {
        if (!applyPolledTurnEvents(eventLog, turn)) {
          // Lost track of the event log; start over with a full poll.
          eventLog = { events: [] };
          continue;
        }
        lastSeenTurnAt = Date.now();
        expectTurn = true;
        const phaseStatusMap: Record<string, string> = { thinking: 'Thinking', tool_exec: 'Executing tool', replying: 'Generating response', booting: 'Starting environment' };
        const statusText = turn.statusText || phaseStatusMap[turn.phase || ''] || '';
        const shown = shownMessage(current.pendingId);
        const parts = buildTurnParts(eventLog.events, shown?.parts);
        const serverText = (turn.fullText || '').trim();
        if (turn.done) {
          current.currentText = takeFileComments(serverText, agentId);
          const finalContent = current.currentText || (turn.error ? `⚠️ ${turn.error}` : '');
          ctx.updateMessage(current.pendingId, {
            content: finalContent, pending: false,
            parts: parts.length ? parts : undefined,
            userRequest: undefined,
          }, effectiveChatId);
          try {
            const cleared = await ctx.acp({ action: 'turn-clear', agentId, chatId: effectiveChatId, messageId: current.pendingId });
            if (!cleared?.ok) throw new Error(cleared?.error || 'Failed to save agent reply');
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            console.error('Failed to finalize agent reply', error);
            ctx.addMessage({
              type: 'system',
              content: `Could not confirm agent reply was saved: ${error}. Keep this tab open and retry loading the chat when the connection recovers.`,
            }, effectiveChatId);
          }
          completeRun(runKey, effectiveChatId);
          return;
        } else {
          const patch: Partial<ChatMessage> = {
            pending: true, ptyPhase: mapTurnPhase(turn.phase || ''),
            statusText: statusText || '', parts: parts.length ? parts : undefined,
            userRequest: turn.userRequest,
          };
          if (serverText) { patch.content = serverText; current.currentText = serverText; }
          // Most polls bring nothing new; skipping them avoids re-rendering the whole chat every 800ms.
          if (!shown || !isNoopMessagePatch(shown, patch)) ctx.updateMessage(current.pendingId, patch, effectiveChatId);
        }
      } else {
        // The server releases a finished turn shortly after it ends, so a tab that missed the final
        // poll (offline, asleep or throttled in the background) must read the reply from the chat.
        const timedOut = Date.now() - lastSeenTurnAt > MISSING_TURN_TIMEOUT;
        if ((expectTurn || timedOut) && Date.now() - lastServerCopyCheckAt >= SERVER_COPY_CHECK_INTERVAL) {
          lastServerCopyCheckAt = Date.now();
          if (await recoverServerReply(runKey, effectiveChatId)) return;
          if (ctx.sessionRunsRef.current[runKey] !== current) return;
        }
        if (timedOut) {
          ctx.updateMessage(current.pendingId, {
            content: current.currentText || '⚠️ Response timed out', pending: false, userRequest: undefined,
          }, effectiveChatId);
          finalizeRun(runKey);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  return { isChatRunning, finalizeRun, resumeActiveTurn, sendAcpPrompt, dispatchToAgent, pollAcpAgent };
}
