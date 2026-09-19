import type { AutoObservation } from './automaticNativeRecovery';
import { atOriginalScale } from './nativeViewportPolicy';

const MARKER = 'viewportHistoryProbe';
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createNativeHistoryBrowser() {
  const originalDocument = document;
  const href = location.href;
  const token = crypto.randomUUID();
  let shell = document.querySelector('.chatPageRoot .page');
  let composer = document.querySelector('.composerTextarea');
  let touches = 0;
  let cycle = 0;
  const read = (): AutoObservation => {
    const state: unknown = history.state;
    const marker = object(state) && state.__NA === true ? state[MARKER] : null;
    const ours = object(marker) && marker.token === token;
    return {
      now: performance.now(), scale: visualViewport?.scale ?? null,
      width: visualViewport?.width ?? null, clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      orientation: matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait',
      touches, editable: !!document.activeElement?.matches('input, textarea, [contenteditable="true"]'),
      overlay: shell?.getAttribute('data-mobile-overlay') !== 'none',
      historyLength: history.length,
      entry: ours && (marker.role === 'working' || marker.role === 'checkpoint') ? marker.role : null,
      entryCycle: ours && typeof marker.cycle === 'number' ? marker.cycle : null,
      sameUrl: location.href === href,
      documentContinuous: document === originalDocument,
      shellContinuous: shell !== null && document.querySelector('.chatPageRoot .page') === shell,
      composerContinuous: composer !== null && document.querySelector('.composerTextarea') === composer,
    };
  };
  const requireEntry = (role: 'working' | 'checkpoint' | null) => {
    const o = read();
    const state: unknown = history.state;
    if (!object(state) || state.__NA !== true || !o.sameUrl || !o.documentContinuous
      || !o.shellContinuous || !o.composerContinuous
      || o.historyLength !== (role === null ? 1 : 2)
      || (role === null ? state[MARKER] !== undefined : o.entry !== role || o.entryCycle !== cycle)) {
      throw new Error('History entry is not owned by this experiment.');
    }
    return state;
  };
  const pushPair = (state: Record<string, unknown>) => {
    history.replaceState({ ...state, [MARKER]: { token, role: 'checkpoint', cycle } }, '', href);
    history.pushState({ ...state, [MARKER]: { token, role: 'working', cycle } }, '', href);
  };
  return {
    read,
    captureChatIdentity() {
      shell = document.querySelector('.chatPageRoot .page');
      composer = document.querySelector('.composerTextarea');
    },
    setTouches(value: number) { touches = value; },
    checkpoint() { pushPair(requireEntry(null)); },
    back() { requireEntry('working'); history.back(); },
    rearm() {
      const state = requireEntry('checkpoint');
      const o = read();
      if (!atOriginalScale(o) || o.touches || o.editable || o.overlay) {
        throw new Error('Native viewport is not ready for re-arming.');
      }
      cycle++;
      pushPair(state);
    },
  };
}
