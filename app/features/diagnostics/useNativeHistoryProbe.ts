'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ProbeEvidence } from '../../../lib/viewportDiagnostics';
import { createNativeHistoryProbe, type ProbeEvent } from './nativeHistoryProbe';

const MARKER = 'viewportHistoryProbe';
const INITIAL_EVIDENCE: ProbeEvidence = {
  phase: 'idle', reason: 'none', owned: false,
  documentContinuous: true, shellContinuous: true, composerContinuous: true,
};
function historyObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

export function useNativeHistoryProbe(
  enabled: boolean, onTransition: (evidence: ProbeEvidence) => void,
) {
  const [evidence, setEvidence] = useState<ProbeEvidence>(INITIAL_EVIDENCE);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>();
  const controllerRef = useRef<ReturnType<typeof createNativeHistoryProbe> | null>(null);
  const evidenceRef = useRef<ProbeEvidence>(INITIAL_EVIDENCE);
  const transitionRef = useRef(onTransition);
  transitionRef.current = onTransition;

  useEffect(() => {
    if (!enabled) return;
    const originalDocument = document;
    const shell = document.querySelector('.chatPageRoot .page');
    const composer = document.querySelector('.composerTextarea');
    const href = location.href;
    const token = crypto.randomUUID();
    let touches = 0;
    const entry = () => {
      const marker = historyObject(historyObject(history.state)?.[MARKER]);
      if (marker?.token !== token) return null;
      return marker.role === 'working' || marker.role === 'checkpoint' ? marker.role : null;
    };
    const controller = createNativeHistoryProbe({
      read: () => ({
        now: performance.now(), scale: visualViewport?.scale ?? null,
        width: visualViewport?.width ?? null, clientWidth: document.documentElement.clientWidth,
        orientation: matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait',
        touches, editable: !!document.activeElement?.matches('input, textarea, [contenteditable="true"]'),
        historyLength: history.length, entry: entry(), sameUrl: location.href === href,
        documentContinuous: document === originalDocument,
        shellContinuous: shell !== null && document.querySelector('.chatPageRoot .page') === shell,
        composerContinuous: composer !== null && document.querySelector('.composerTextarea') === composer,
      }),
      checkpoint: () => {
        const state: unknown = history.state;
        const existing = historyObject(state);
        if ((state !== null && !existing) || existing?.[MARKER] !== undefined) {
          throw new Error('History entry is not suitable for a probe checkpoint.');
        }
        history.replaceState({ ...existing, [MARKER]: { token, role: 'checkpoint' } }, '', href);
        history.pushState({ ...existing, [MARKER]: { token, role: 'working' } }, '', href);
      },
      back: () => history.back(),
      publish: next => {
        evidenceRef.current = next;
        setEvidence(next);
        transitionRef.current(next);
      },
    });
    controllerRef.current = controller;
    evidenceRef.current = controller.evidence();
    setEvidence(evidenceRef.current);
    const sample = (event: ProbeEvent = 'tick') => controller.observe(event);
    const tick = () => sample();
    const orientation = () => sample('orientation');
    const navigation = () => sample('navigation');
    const popstate = () => sample('popstate');
    const lifecycle = () => sample('lifecycle');
    const touch = (event: TouchEvent) => {
      touches = event.touches.length;
      // The touch that activates a control precedes its click; never cancel it.
      if (touches > 0) sample('touch');
      else sample();
    };
    const position = () => {
      const viewport = window.visualViewport;
      if (!viewport) return;
      setPanelStyle({
        left: viewport.offsetLeft + 8,
        top: viewport.offsetTop + 8,
        bottom: 'auto',
        width: Math.max(0, Math.min(276, viewport.width - 16)),
        maxWidth: Math.max(0, viewport.width - 16),
        maxHeight: Math.max(0, viewport.height - 16),
        overflowY: 'auto',
        boxSizing: 'border-box',
      });
      tick();
    };
    const timer = window.setInterval(tick, 100);
    window.addEventListener('orientationchange', orientation);
    window.addEventListener('popstate', popstate);
    window.addEventListener('hashchange', navigation);
    window.addEventListener('pagehide', lifecycle);
    window.addEventListener('resize', position);
    for (const name of ['touchstart', 'touchend', 'touchcancel'] as const) {
      window.addEventListener(name, touch, { passive: true });
    }
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    position();
    return () => {
      controller.observe('lifecycle');
      controllerRef.current = null;
      clearInterval(timer);
      window.removeEventListener('orientationchange', orientation);
      window.removeEventListener('popstate', popstate);
      window.removeEventListener('hashchange', navigation);
      window.removeEventListener('pagehide', lifecycle);
      window.removeEventListener('resize', position);
      for (const name of ['touchstart', 'touchend', 'touchcancel'] as const) window.removeEventListener(name, touch);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [enabled]);

  return {
    evidence, evidenceRef, panelStyle,
    arm: () => controllerRef.current?.arm(),
    restore: () => controllerRef.current?.restore(),
  };
}
