'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AnyProbeEvidence, ProbeEvidence } from '../../../lib/viewportDiagnostics';
import { createNativeHistoryProbe, type ProbeEvent } from './nativeHistoryProbe';
import { createAutomaticNativeRecovery } from './automaticNativeRecovery';
import { createPreventiveNativeRecovery } from './preventiveNativeRecovery';
import { createNativeHistoryBrowser } from './nativeHistoryBrowser';

const INITIAL_EVIDENCE: ProbeEvidence = {
  phase: 'idle', reason: 'none', owned: false,
  documentContinuous: true, shellContinuous: true, composerContinuous: true,
};
type HistoryController = {
  arm: () => void;
  observe: (event?: ProbeEvent) => void;
  evidence: () => AnyProbeEvidence;
  restore?: () => void;
  stop?: () => void;
};

export function useNativeHistoryProbe(
  kind: 'manual' | 'auto' | 'preventive' | null, onTransition: (evidence: AnyProbeEvidence) => void,
) {
  const [evidence, setEvidence] = useState<AnyProbeEvidence>(INITIAL_EVIDENCE);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>();
  const controllerRef = useRef<HistoryController | null>(null);
  const evidenceRef = useRef<AnyProbeEvidence>(INITIAL_EVIDENCE);
  const transitionRef = useRef(onTransition);
  transitionRef.current = onTransition;

  useEffect(() => {
    if (!kind) return;
    const browser = createNativeHistoryBrowser();
    const ports = {
      ...browser,
      publish: (next: AnyProbeEvidence) => {
        evidenceRef.current = next;
        setEvidence(next);
        transitionRef.current(next);
      },
    };
    const controller: HistoryController = kind === 'preventive' ? createPreventiveNativeRecovery(ports)
      : kind === 'auto' ? createAutomaticNativeRecovery(ports) : createNativeHistoryProbe(ports);
    controllerRef.current = {
      ...controller,
      arm: () => {
        if (controller.evidence().phase !== 'idle') return;
        browser.captureChatIdentity();
        controller.arm();
      },
    };
    evidenceRef.current = controller.evidence();
    setEvidence(evidenceRef.current);
    const sample = (event: ProbeEvent = 'tick') => controller.observe(event);
    const tick = () => sample();
    const orientation = () => sample('orientation');
    const navigation = () => sample('navigation');
    const popstate = () => sample('popstate');
    const lifecycle = () => sample('lifecycle');
    const focus = () => { if (kind !== 'manual') sample('focus'); };
    const touch = (event: TouchEvent) => {
      browser.setTouches(event.touches.length);
      // The touch that activates a control precedes its click; never cancel it.
      if (event.touches.length > 0) sample('touch');
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
    window.screen.orientation?.addEventListener('change', orientation);
    window.addEventListener('popstate', popstate);
    window.addEventListener('hashchange', navigation);
    window.addEventListener('pagehide', lifecycle);
    window.addEventListener('resize', position);
    window.addEventListener('focusin', focus);
    window.addEventListener('focusout', focus);
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
      window.screen.orientation?.removeEventListener('change', orientation);
      window.removeEventListener('popstate', popstate);
      window.removeEventListener('hashchange', navigation);
      window.removeEventListener('pagehide', lifecycle);
      window.removeEventListener('resize', position);
      window.removeEventListener('focusin', focus);
      window.removeEventListener('focusout', focus);
      for (const name of ['touchstart', 'touchend', 'touchcancel'] as const) window.removeEventListener(name, touch);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [kind]);

  const readEvidence = useCallback(() => controllerRef.current?.evidence() ?? evidenceRef.current, []);
  return {
    evidence, readEvidence, panelStyle,
    arm: () => controllerRef.current?.arm(),
    restore: () => controllerRef.current?.restore?.(),
    stop: () => controllerRef.current?.stop?.(),
  };
}
