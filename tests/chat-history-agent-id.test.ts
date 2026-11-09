import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatHistoryEntry } from '../app/features/chat/chatTypes';
import { createPersistenceHandlers, type PersistenceContext } from '../app/features/chat/runtime/chatPersistenceService';

function harness(history: ChatHistoryEntry[], serverChat: Record<string, unknown>) {
  const state = { history };
  const ref = <T,>(current: T) => ({ current });
  const noop = () => {};
  const ctx = {
    chatSaver: { hydrate: noop, save: async () => {} },
    acp: async () => ({}),
    currentChatIdRef: ref(''),
    currentAgentSessionsRef: ref({}),
    needsContextRestoreRef: ref(false),
    chatMessagesRef: ref({}),
    messagesRef: ref([]),
    chatNameRef: ref(''),
    chatAgentFilterRef: ref(null),
    chatHistoryRef: { get current() { return state.history; }, set current(_v) {} },
    setChatHistory: (next: ChatHistoryEntry[] | ((prev: ChatHistoryEntry[]) => ChatHistoryEntry[])) => {
      state.history = typeof next === 'function' ? next(state.history) : next;
    },
    setChatName: noop, setChatCounter: noop, setCurrentChatId: noop, setActiveSidebarChatId: noop,
    setShareDialog: noop, setExpandedMessages: noop, setMessagesForChat: noop,
    addMessage: () => 'id', resumeActiveTurn: noop,
  } as unknown as PersistenceContext;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, chat: serverChat }))) as typeof fetch;
  return { handlers: createPersistenceHandlers(ctx), state };
}

const serverChat = { id: 'c1', name: 'dev', ts: 1, messages: [], agentSessions: {} };

test('reloading a chat into cache keeps the chat agent', async () => {
  const fromServer = harness([{ id: 'c1', name: 'dev', ts: 1 }], { ...serverChat, agentId: 'agent.dev' });
  await fromServer.handlers.loadChatIntoCache('c1');
  assert.equal(fromServer.state.history[0].agentId, 'agent.dev');

  const fromClient = harness([{ id: 'c1', name: 'dev', ts: 1, agentId: 'agent.dev' }], serverChat);
  await fromClient.handlers.loadChatIntoCache('c1');
  assert.equal(fromClient.state.history[0].agentId, 'agent.dev');
});
