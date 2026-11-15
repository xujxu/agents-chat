'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Agent } from '../../agents/agentTypes';
import type { ChatMessage, AgentUserRequestResponse } from '../../chat/chatTypes';
import { useStableCallback } from '../../chat/hooks/useStableCallback';
import type { FailedSendByMessageId } from '../messageTypes';
import { MessageBubble, getMessageCopyText } from './MessageBubble';
import { ChatWelcome } from './ChatWelcome';
import { MESSAGE_WINDOW_STEP, resolveMessageWindowStart } from '../messageWindow';

export function MessageList({
  messages,
  isEmptyChat,
  agents,
  expandedMessages,
  failedSendByMessageId,
  onToggleExpanded,
  onRetryFailedSend,
  onOpenImage,
  onAnswerAgentUserRequest,
  onDismissAgentUserRequest,
}: {
  messages: ChatMessage[];
  isEmptyChat: boolean;
  agents: Agent[];
  expandedMessages: Record<string, boolean>;
  failedSendByMessageId: FailedSendByMessageId;
  onToggleExpanded: (messageId: string) => void;
  onRetryFailedSend: (messageId: string) => void;
  onOpenImage: (src: string) => void;
  onAnswerAgentUserRequest: (requestId: string, response: AgentUserRequestResponse) => Promise<void>;
  onDismissAgentUserRequest: (requestId: string) => void;
}) {
  const [toasts, setToasts] = useState<Array<{ id: string; text: string }>>([]);
  const [mounted, setMounted] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copiedFormattedMessageId, setCopiedFormattedMessageId] = useState<string | null>(null);
  const seenSystemMessageIdsRef = useRef<Set<string>>(new Set());
  const toastTimeoutsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    return () => {
      for (const timeoutId of Object.values(toastTimeoutsRef.current)) {
        window.clearTimeout(timeoutId);
      }
      toastTimeoutsRef.current = {};
    };
  }, []);

  useEffect(() => {
    const now = Date.now();
    for (const message of messages) {
      if (message.type !== 'system') continue;
      if (message.id === 'welcome') continue;
      if (seenSystemMessageIdsRef.current.has(message.id)) continue;
      seenSystemMessageIdsRef.current.add(message.id);
      if (typeof message.ts === 'number' && now - message.ts > 15000) continue;

      const toastText = (message.content || '').replace(/^✅\s*/, '').trim();
      if (!toastText) continue;

      const toastId = `toast-${message.id}`;
      setToasts((prev) => [...prev, { id: toastId, text: toastText }]);
      const timeoutId = window.setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== toastId));
        delete toastTimeoutsRef.current[toastId];
      }, 3600);
      toastTimeoutsRef.current[toastId] = timeoutId;
    }
  }, [messages]);

  const chatMessages = useMemo(() => messages.filter((message) => message.type !== 'system'), [messages]);

  // Long chats mount only the newest messages first; older ones are added when the reader
  // scrolls near the top or asks for them. The window start is a message id, so new replies
  // extend the window instead of pushing rendered messages out, and it belongs to the chat
  // whose first message is `firstId`, so switching chats resets it.
  const [messageWindow, setMessageWindow] = useState<{ firstId: string; startId: string | null } | null>(null);
  const firstId = chatMessages[0]?.id ?? '';
  const startIndex = resolveMessageWindowStart(chatMessages, messageWindow?.firstId === firstId ? messageWindow.startId : undefined);
  const resolvedStartId = startIndex > 0 ? chatMessages[startIndex].id : null;
  if (firstId && (messageWindow?.firstId !== firstId || messageWindow.startId !== resolvedStartId)) {
    setMessageWindow({ firstId, startId: resolvedStartId });
  }
  const visibleMessages = useMemo(
    () => startIndex > 0 ? chatMessages.slice(startIndex) : chatMessages,
    [chatMessages, startIndex],
  );
  const olderBarRef = useRef<HTMLDivElement | null>(null);
  const prependRef = useRef<{ container: HTMLElement; top: number; height: number } | null>(null);
  const startIndexRef = useRef(startIndex);
  startIndexRef.current = startIndex;
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;

  const showEarlier = useStableCallback((all: boolean) => {
    const current = startIndexRef.current;
    if (current <= 0) return;
    const container = olderBarRef.current?.closest<HTMLElement>('.chatContainer');
    if (container) prependRef.current = { container, top: container.scrollTop, height: container.scrollHeight };
    const next = all ? 0 : Math.max(0, current - MESSAGE_WINDOW_STEP);
    const list = chatMessagesRef.current;
    setMessageWindow({ firstId: list[0]?.id ?? '', startId: next > 0 ? list[next].id : null });
  });

  // Keep what the reader is looking at in place when older messages are inserted above it.
  useLayoutEffect(() => {
    const prepend = prependRef.current;
    prependRef.current = null;
    if (prepend) prepend.container.scrollTop = prepend.top + prepend.container.scrollHeight - prepend.height;
  }, [startIndex]);

  useEffect(() => {
    const bar = olderBarRef.current;
    const root = bar?.closest<HTMLElement>('.chatContainer');
    if (!bar || !root || typeof IntersectionObserver === 'undefined') return;
    // Re-created after every load so a bar that is still near the top keeps loading.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showEarlier(false);
    }, { root, rootMargin: '400px 0px 0px 0px' });
    observer.observe(bar);
    return () => observer.disconnect();
  }, [startIndex, showEarlier]);

  // Browser find only searches rendered text, so render everything when it is opened.
  const hasHiddenMessages = startIndex > 0;
  useEffect(() => {
    if (!hasHiddenMessages) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        flushSync(() => showEarlier(true));
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [hasHiddenMessages, showEarlier]);

  const messagesById = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);
  const messagesByIdRef = useRef(messagesById);
  messagesByIdRef.current = messagesById;

  const handleCopy = useStableCallback((messageId: string) => {
    const message = messagesByIdRef.current.get(messageId);
    if (!message) return;
    const text = getMessageCopyText(message);
    navigator.clipboard.writeText(text).then(() => {
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedMessageId((current) => current === message.id ? null : current);
      }, 1500);
    }).catch((err) => {
      console.error('Failed to copy message', err);
    });
  });

  const handleCopyFormatted = useStableCallback((messageId: string, html: string, text: string) => {
    const message = messagesByIdRef.current.get(messageId);
    if (!message) return;
    const flagCopied = () => {
      setCopiedFormattedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedFormattedMessageId((current) => current === message.id ? null : current);
      }, 1500);
    };
    const fallbackText = text || getMessageCopyText(message);
    const ClipboardItemCtor = typeof window !== 'undefined' ? (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem : undefined;
    if (ClipboardItemCtor && navigator.clipboard && typeof navigator.clipboard.write === 'function') {
      const item = new ClipboardItemCtor({
        'text/html': new Blob([html || `<pre>${fallbackText}</pre>`], { type: 'text/html' }),
        'text/plain': new Blob([fallbackText], { type: 'text/plain' }),
      });
      navigator.clipboard.write([item]).then(flagCopied).catch((err) => {
        console.error('Failed to copy formatted message, falling back to plain text', err);
        navigator.clipboard.writeText(fallbackText).then(flagCopied).catch((err2) => {
          console.error('Failed to copy message', err2);
        });
      });
    } else {
      navigator.clipboard.writeText(fallbackText).then(flagCopied).catch((err) => {
        console.error('Failed to copy message', err);
      });
    }
  });

  // Stabilize callback identities so React.memo on MessageBubble works.
  const stableToggleExpanded = useStableCallback(onToggleExpanded);
  const stableRetryFailedSend = useStableCallback(onRetryFailedSend);
  const stableOpenImage = useStableCallback(onOpenImage);
  const stableAnswerRequest = useStableCallback(onAnswerAgentUserRequest);
  const stableDismissRequest = useStableCallback(onDismissAgentUserRequest);

  return (
    <>
      {toasts.length > 0 ? (
        <div className="chatToastStack" aria-live="polite" aria-atomic="false">
          {toasts.map((toast) => (
            <div key={toast.id} className="chatToast" role="status">{toast.text}</div>
          ))}
        </div>
      ) : null}
      {isEmptyChat ? <ChatWelcome /> : null}
      {startIndex > 0 ? (
        <div className="olderMessagesBar" ref={olderBarRef}>
          <span>{startIndex.toLocaleString('en-US')} earlier {startIndex === 1 ? 'message' : 'messages'} not shown</span>
          <button type="button" onClick={() => showEarlier(false)}>Show earlier</button>
          <button type="button" onClick={() => showEarlier(true)}>Show all</button>
        </div>
      ) : null}
      {visibleMessages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          agents={agents}
          failedSend={failedSendByMessageId[message.id] ?? null}
          isCollapsed={expandedMessages[message.id] === false}
          mounted={mounted}
          isCopied={copiedMessageId === message.id}
          isCopiedFormatted={copiedFormattedMessageId === message.id}
          onCopy={handleCopy}
          onCopyFormatted={handleCopyFormatted}
          onToggleExpanded={stableToggleExpanded}
          onRetryFailedSend={stableRetryFailedSend}
          onOpenImage={stableOpenImage}
          onAnswerAgentUserRequest={stableAnswerRequest}
          onDismissAgentUserRequest={stableDismissRequest}
        />
      ))}
    </>
  );
}
