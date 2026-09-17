'use client';

import { useEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { useDesktopViewportSync } from '../hooks/useDesktopViewportSync';
import type { MobileOverlay } from '../hooks/useMobileOverlayState';

export type ChatShellProps = {
  sidebar: ReactNode;
  header: ReactNode;
  messages: ReactNode;
  composer: ReactNode;
  rightPanel: ReactNode | null;
  statusBar: ReactNode;
  shareDialog: ReactNode | null;
  imageLightbox: ReactNode | null;
  workflowPicker?: ReactNode | null;
  mobileOverlay: MobileOverlay;
  isMobileLayout: boolean;
  onMobileOverlayClose: () => void;
  themeStyle: CSSProperties;
  themeId: string;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  agentsSidebarOpen: boolean;
  onSidebarResizeStart: (e: MouseEvent<HTMLDivElement>) => void;
};

export function ChatShell({
  sidebar,
  header,
  messages,
  composer,
  rightPanel,
  statusBar,
  shareDialog,
  imageLightbox,
  workflowPicker,
  mobileOverlay,
  isMobileLayout,
  onMobileOverlayClose,
  themeStyle,
  themeId,
  sidebarWidth,
  sidebarCollapsed,
  agentsSidebarOpen,
  onSidebarResizeStart,
}: ChatShellProps) {
  const pageRef = useRef<HTMLElement | null>(null);
  const hasModalMobileOverlay = isMobileLayout && mobileOverlay !== null;

  useDesktopViewportSync({ pageRef, isMobileLayout });

  useEffect(() => {
    if (!isMobileLayout || mobileOverlay === null) return;

    let retryFrame = 0;
    const focusOverlay = () => {
      const surfaceSelector = mobileOverlay === 'navigation'
        ? '.participantsSidebar'
        : `[data-mobile-overlay-surface="${mobileOverlay}"]`;
      const surface = pageRef.current?.querySelector<HTMLElement>(surfaceSelector);
      const target = surface?.querySelector<HTMLElement>('[data-mobile-overlay-initial-focus]')
        ?? surface?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ?? surface;
      if (target) target.focus();
      else retryFrame = window.requestAnimationFrame(focusOverlay);
    };
    const frame = window.requestAnimationFrame(focusOverlay);
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(retryFrame);
    };
  }, [isMobileLayout, mobileOverlay]);

  return (
    <main
      ref={pageRef}
      className="page"
      style={themeStyle}
      data-theme={themeId}
      data-mobile-overlay={mobileOverlay ?? 'none'}
      suppressHydrationWarning
    >
      {header}
      {isMobileLayout && mobileOverlay !== null ? (
        <button
          type="button"
          className="mobilePanelBackdrop"
          aria-label="Close active panel"
          onClick={onMobileOverlayClose}
        />
      ) : null}
      <div
        className={`chatLayout${sidebarCollapsed ? ' sidebarCollapsed' : ''}${agentsSidebarOpen ? ' agentsSidebarOpen' : ''}`}
        style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      >
        {sidebar}
        {!sidebarCollapsed && (
          <div className="sidebarResizeHandle" onMouseDown={onSidebarResizeStart} />
        )}
        <div className="chatMain" aria-hidden={hasModalMobileOverlay || undefined}>
          {messages}
          {composer}
        </div>
        {rightPanel}
      </div>
      {shareDialog}
      {imageLightbox}
      {workflowPicker}
      {statusBar}
    </main>
  );
}
