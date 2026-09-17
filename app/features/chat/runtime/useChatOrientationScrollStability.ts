'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
} from 'react';
import { APP_VIEWPORT_WILL_CHANGE_EVENT } from '../../layout/viewportEvents';

const BOTTOM_THRESHOLD = 4;
const VIEWPORT_SETTLE_MS = 250;

type StableAnchor =
  | { kind: 'bottom'; scrollTop: number }
  | {
      kind: 'message';
      element: HTMLElement;
      offsetTop: number;
      scrollTop: number;
    };

type UseChatOrientationScrollStabilityOptions = {
  containerRef: MutableRefObject<HTMLElement | null>;
  shouldStickToBottomRef: MutableRefObject<boolean>;
  lastScrollTopRef: MutableRefObject<number>;
  setShowScrollToBottom: (show: boolean) => void;
};

export function useChatOrientationScrollStability({
  containerRef,
  shouldStickToBottomRef,
  lastScrollTopRef,
  setShowScrollToBottom,
}: UseChatOrientationScrollStabilityOptions) {
  const stableAnchorRef = useRef<StableAnchor | null>(null);
  const relayoutActiveRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const firstFrameRef = useRef(0);
  const secondFrameRef = useRef(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedContainerRef = useRef<HTMLElement | null>(null);

  const captureStableAnchor = useCallback((container: HTMLElement) => {
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= BOTTOM_THRESHOLD) {
      stableAnchorRef.current = {
        kind: 'bottom',
        scrollTop: container.scrollTop,
      };
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    const messages = Array.from(
      container.querySelectorAll<HTMLElement>('.message'),
    );
    const anchor = messages.find((message) =>
      message.getBoundingClientRect().bottom > containerTop
    );
    stableAnchorRef.current = anchor
      ? {
          kind: 'message',
          element: anchor,
          offsetTop: anchor.getBoundingClientRect().top - containerTop,
          scrollTop: container.scrollTop,
        }
      : null;
  }, []);

  const restoreStableAnchor = useCallback(() => {
    const container = containerRef.current;
    const anchor = stableAnchorRef.current;
    if (!container || !anchor) {
      relayoutActiveRef.current = false;
      return;
    }

    const maxScrollTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight,
    );
    let nextScrollTop: number;
    if (anchor.kind === 'bottom') {
      nextScrollTop = maxScrollTop;
    } else if (anchor.element.isConnected) {
      const containerTop = container.getBoundingClientRect().top;
      const currentOffset =
        anchor.element.getBoundingClientRect().top - containerTop;
      nextScrollTop = container.scrollTop + currentOffset - anchor.offsetTop;
    } else {
      nextScrollTop = anchor.scrollTop;
    }

    container.scrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const pinnedToBottom =
      anchor.kind === 'bottom' || distanceFromBottom <= BOTTOM_THRESHOLD;
    shouldStickToBottomRef.current = pinnedToBottom;
    lastScrollTopRef.current = container.scrollTop;
    setShowScrollToBottom(!pinnedToBottom);
    relayoutActiveRef.current = false;
    captureStableAnchor(container);
  }, [
    captureStableAnchor,
    containerRef,
    lastScrollTopRef,
    setShowScrollToBottom,
    shouldStickToBottomRef,
  ]);

  const scheduleRestore = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (shouldStickToBottomRef.current) {
      stableAnchorRef.current = {
        kind: 'bottom',
        scrollTop: container.scrollTop,
      };
    } else if (!stableAnchorRef.current) {
      captureStableAnchor(container);
    }
    relayoutActiveRef.current = true;

    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
    }
    window.cancelAnimationFrame(firstFrameRef.current);
    window.cancelAnimationFrame(secondFrameRef.current);

    settleTimerRef.current = window.setTimeout(() => {
      firstFrameRef.current = window.requestAnimationFrame(() => {
        secondFrameRef.current = window.requestAnimationFrame(
          restoreStableAnchor,
        );
      });
    }, VIEWPORT_SETTLE_MS);
  }, [
    captureStableAnchor,
    containerRef,
    restoreStableAnchor,
    shouldStickToBottomRef,
  ]);

  const observeContainer = useCallback((container: HTMLElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    observedContainerRef.current = container;
    containerRef.current = container;
    if (!container) return;

    captureStableAnchor(container);
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (observedContainerRef.current === container) scheduleRestore();
    });
    observer.observe(container);
    resizeObserverRef.current = observer;
  }, [captureStableAnchor, containerRef, scheduleRestore]);

  useEffect(() => {
    const captureBeforeRelayout = () => {
      const container = containerRef.current;
      if (container) captureStableAnchor(container);
      scheduleRestore();
    };

    window.addEventListener(APP_VIEWPORT_WILL_CHANGE_EVENT, captureBeforeRelayout);
    window.addEventListener('resize', scheduleRestore);
    window.addEventListener('orientationchange', scheduleRestore);
    return () => {
      window.removeEventListener(APP_VIEWPORT_WILL_CHANGE_EVENT, captureBeforeRelayout);
      window.removeEventListener('resize', scheduleRestore);
      window.removeEventListener('orientationchange', scheduleRestore);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      observedContainerRef.current = null;
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current);
      }
      window.cancelAnimationFrame(firstFrameRef.current);
      window.cancelAnimationFrame(secondFrameRef.current);
    };
  }, [captureStableAnchor, containerRef, scheduleRestore]);

  const handleRelayoutScroll = useCallback(() =>
    relayoutActiveRef.current, []);

  return {
    captureStableAnchor,
    handleRelayoutScroll,
    observeContainer,
  };
}
