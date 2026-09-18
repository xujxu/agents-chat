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
  const restoreScheduledRef = useRef(false);
  const restoreWriteRef = useRef<{
    container: HTMLElement;
    scrollTop: number;
  } | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const firstFrameRef = useRef(0);
  const secondFrameRef = useRef(0);
  const clearRestoreWriteFrameRef = useRef(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedContainerRef = useRef<HTMLElement | null>(null);
  const observedSizeRef = useRef({ width: 0, height: 0 });
  const removeInputListenersRef = useRef<(() => void) | null>(null);

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
      restoreScheduledRef.current = false;
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

    const boundedScrollTop = Math.max(
      0,
      Math.min(nextScrollTop, maxScrollTop),
    );
    restoreWriteRef.current = {
      container,
      scrollTop: boundedScrollTop,
    };
    container.scrollTop = boundedScrollTop;
    window.cancelAnimationFrame(clearRestoreWriteFrameRef.current);
    clearRestoreWriteFrameRef.current = window.requestAnimationFrame(() => {
      restoreWriteRef.current = null;
    });
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const pinnedToBottom =
      anchor.kind === 'bottom' || distanceFromBottom <= BOTTOM_THRESHOLD;
    shouldStickToBottomRef.current = pinnedToBottom;
    lastScrollTopRef.current = container.scrollTop;
    setShowScrollToBottom(!pinnedToBottom);
    restoreScheduledRef.current = false;
    captureStableAnchor(container);
  }, [
    captureStableAnchor,
    containerRef,
    lastScrollTopRef,
    setShowScrollToBottom,
    shouldStickToBottomRef,
  ]);

  const cancelScheduledRestore = useCallback(() => {
    restoreScheduledRef.current = false;
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    window.cancelAnimationFrame(firstFrameRef.current);
    window.cancelAnimationFrame(secondFrameRef.current);
  }, []);

  const scheduleRestore = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (restoreScheduledRef.current) return;
    if (!stableAnchorRef.current) {
      captureStableAnchor(container);
    }
    restoreScheduledRef.current = true;

    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
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
  ]);

  const scrollToLatest = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    cancelScheduledRestore();
    restoreWriteRef.current = null;
    observedSizeRef.current = {
      width: container.clientWidth,
      height: container.clientHeight,
    };
    stableAnchorRef.current = { kind: 'bottom', scrollTop: container.scrollTop };
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [
    cancelScheduledRestore,
    containerRef,
    setShowScrollToBottom,
    shouldStickToBottomRef,
  ]);

  const observeContainer = useCallback((container: HTMLElement | null) => {
    cancelScheduledRestore();
    resizeObserverRef.current?.disconnect();
    removeInputListenersRef.current?.();
    resizeObserverRef.current = null;
    observedContainerRef.current = container;
    containerRef.current = container;
    stableAnchorRef.current = null;
    restoreWriteRef.current = null;
    if (!container) return;

    observedSizeRef.current = { width: container.clientWidth, height: container.clientHeight };
    captureStableAnchor(container);
    const onUserInput = (event: Event) => {
      if (event instanceof KeyboardEvent
        && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
      cancelScheduledRestore();
      restoreWriteRef.current = null;
      observedSizeRef.current = {
        width: container.clientWidth,
        height: container.clientHeight,
      };
      captureStableAnchor(container);
    };
    for (const type of ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown']) {
      container.addEventListener(type, onUserInput, { passive: true });
    }
    removeInputListenersRef.current = () => {
      for (const type of ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown']) {
        container.removeEventListener(type, onUserInput);
      }
    };
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (observedContainerRef.current !== container) return;
      const { width, height } = observedSizeRef.current;
      if (width === container.clientWidth && height === container.clientHeight) return;
      observedSizeRef.current = { width: container.clientWidth, height: container.clientHeight };
      scheduleRestore();
    });
    observer.observe(container);
    resizeObserverRef.current = observer;
  }, [
    cancelScheduledRestore,
    captureStableAnchor,
    containerRef,
    scheduleRestore,
  ]);

  useEffect(() => {
    const captureBeforeRelayout = () => {
      const container = containerRef.current;
      if (container) captureStableAnchor(container);
      scheduleRestore();
    };
    const scheduleCurrentRestore = () => scheduleRestore();

    window.addEventListener(APP_VIEWPORT_WILL_CHANGE_EVENT, captureBeforeRelayout);
    window.addEventListener('resize', scheduleCurrentRestore);
    window.addEventListener('orientationchange', scheduleCurrentRestore);
    return () => {
      window.removeEventListener(APP_VIEWPORT_WILL_CHANGE_EVENT, captureBeforeRelayout);
      window.removeEventListener('resize', scheduleCurrentRestore);
      window.removeEventListener('orientationchange', scheduleCurrentRestore);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      observedContainerRef.current = null;
      removeInputListenersRef.current?.();
      removeInputListenersRef.current = null;
      cancelScheduledRestore();
      window.cancelAnimationFrame(clearRestoreWriteFrameRef.current);
      restoreWriteRef.current = null;
    };
  }, [
    cancelScheduledRestore,
    captureStableAnchor,
    containerRef,
    scheduleRestore,
  ]);

  const handleRelayoutScroll = useCallback((container: HTMLElement) => {
    const restoreWrite = restoreWriteRef.current;
    if (restoreWrite?.container === container) {
      restoreWriteRef.current = null;
      if (Math.abs(restoreWrite.scrollTop - container.scrollTop) <= 1) return true;
    }
    const { width, height } = observedSizeRef.current;
    if (width !== container.clientWidth || height !== container.clientHeight) {
      scheduleRestore();
    }
    return restoreScheduledRef.current;
  }, [scheduleRestore]);

  return {
    captureStableAnchor,
    handleRelayoutScroll,
    observeContainer,
    scrollToLatest,
  };
}
