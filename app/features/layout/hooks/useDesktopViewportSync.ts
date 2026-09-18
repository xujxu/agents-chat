'use client';

import { useEffect, type RefObject } from 'react';
import { APP_VIEWPORT_WILL_CHANGE_EVENT } from '../viewportEvents';
import { MOBILE_LAYOUT_QUERY } from './useMobileOverlayState';

type UseDesktopViewportSyncOptions = {
  pageRef: RefObject<HTMLElement | null>;
  isMobileLayout: boolean;
};

export function useDesktopViewportSync({
  pageRef,
  isMobileLayout,
}: UseDesktopViewportSyncOptions) {
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;

    const clearViewportProperties = () => {
      page.style.removeProperty('--app-viewport-height');
      page.style.removeProperty('--app-viewport-offset-top');
    };

    if (isMobileLayout || window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
      clearViewportProperties();
      return clearViewportProperties;
    }

    const visualViewport = window.visualViewport;
    const syncViewport = () => {
      const height = visualViewport?.height ?? window.innerHeight;
      const offsetTop = visualViewport?.offsetTop ?? 0;
      window.dispatchEvent(new Event(APP_VIEWPORT_WILL_CHANGE_EVENT));
      page.style.setProperty('--app-viewport-height', `${Math.round(height)}px`);
      page.style.setProperty('--app-viewport-offset-top', `${Math.round(offsetTop)}px`);
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', syncViewport);
    visualViewport?.addEventListener('resize', syncViewport);
    visualViewport?.addEventListener('scroll', syncViewport);
    return () => {
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
      visualViewport?.removeEventListener('resize', syncViewport);
      visualViewport?.removeEventListener('scroll', syncViewport);
    };
  }, [isMobileLayout, pageRef]);
}
