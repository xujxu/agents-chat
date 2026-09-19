import type { ProbeEvidence } from '../../../lib/viewportDiagnostics';
import { atOriginalScale, createViewportStability, validGeometry } from './nativeViewportPolicy.ts';

export type ProbeObservation = {
  now: number;
  scale: number | null;
  width: number | null;
  clientWidth: number;
  orientation: 'portrait' | 'landscape';
  touches: number;
  editable: boolean;
  historyLength: number;
  entry: 'checkpoint' | 'working' | null;
  sameUrl: boolean;
  documentContinuous: boolean;
  shellContinuous: boolean;
  composerContinuous: boolean;
};
export type ProbeEvent = 'tick' | 'touch' | 'orientation' | 'popstate' | 'navigation' | 'lifecycle' | 'focus';
export type ProbePorts = {
  read: () => ProbeObservation;
  checkpoint: () => void;
  back: () => void;
  publish: (evidence: ProbeEvidence) => void;
};

const continuous = (o: ProbeObservation) =>
  o.sameUrl && o.documentContinuous && o.shellContinuous && o.composerContinuous;

export function createNativeHistoryProbe(ports: ProbePorts) {
  let phase: ProbeEvidence['phase'] = 'idle';
  let reason: ProbeEvidence['reason'] = 'none';
  let initialOrientation: ProbeObservation['orientation'] | null = null;
  let rotated = false;
  let deadline = 0;
  let acknowledged = false;
  const stability = createViewportStability();

  const evidence = (): ProbeEvidence => {
    const o = ports.read();
    return {
      phase, reason,
      owned: o.historyLength === 2 && continuous(o) && o.entry !== null,
      documentContinuous: o.documentContinuous, shellContinuous: o.shellContinuous,
      composerContinuous: o.composerContinuous,
    };
  };
  const set = (next: ProbeEvidence['phase'], why: ProbeEvidence['reason'] = 'none') => {
    if (phase === next && reason === why) return;
    phase = next;
    reason = why;
    ports.publish(evidence());
  };
  const terminal = () => ['restored', 'not-restored', 'invalidated', 'error'].includes(phase);
  const stable = stability.sample;
  const initialRefusal = (o: ProbeObservation): ProbeEvidence['reason'] => {
    if (!continuous(o)) return 'ownership';
    if (o.historyLength !== 1 || o.entry !== null) return 'fresh-tab';
    if (o.touches) return 'touch';
    if (o.editable) return 'focus';
    return atOriginalScale(o) ? 'none' : 'geometry';
  };
  const ownership = (o: ProbeObservation) => {
    if (!continuous(o) || o.historyLength !== 2 || o.entry === null
      || (phase === 'armed' && o.entry !== 'working')
      || (phase === 'restoring' && acknowledged && o.entry !== 'checkpoint')) {
      set('invalidated', 'ownership');
      return false;
    }
    return true;
  };

  const observe = (event: ProbeEvent = 'tick') => {
    if (terminal()) return;
    const o = ports.read();
    const settled = stable(o);
    if (event === 'lifecycle' || event === 'navigation') {
      set('invalidated', event === 'lifecycle' ? 'lifecycle' : 'ownership');
      return;
    }
    if (phase === 'arming') {
      if (event === 'touch' || event === 'popstate' || initialRefusal(o) !== 'none') {
        set('invalidated', 'interrupted');
        return;
      }
      if (o.now > deadline) {
        set('invalidated', 'unstable');
        return;
      }
      if (settled) {
        set('armed');
        try {
          ports.checkpoint();
          ownership(ports.read());
          ports.publish(evidence());
        } catch {
          set('error', 'history-error');
        }
      }
      return;
    }
    if (phase !== 'armed' && phase !== 'restoring') return;
    if (!ownership(o)) return;
    if (phase === 'armed') {
      if (event === 'popstate') {
        set('invalidated', 'ownership');
        return;
      }
      if (initialOrientation !== o.orientation) rotated = true;
      return;
    }
    if (event === 'touch' || o.touches || o.editable) {
      set('invalidated', 'interrupted');
      return;
    }
    if (o.now > deadline) {
      set('not-restored', acknowledged ? 'scale-timeout' : 'ack-timeout');
      return;
    }
    if (event === 'popstate') {
      if (acknowledged || o.entry !== 'checkpoint') {
        set('invalidated', 'ownership');
        return;
      }
      acknowledged = true;
      deadline = o.now + 3000;
      stability.reset();
      ports.publish(evidence());
      return;
    }
    if (acknowledged && settled && atOriginalScale(o)) {
      set('restored');
    } else if (o.now >= deadline) {
      set('not-restored', acknowledged ? 'scale-timeout' : 'ack-timeout');
    }
  };

  return {
    evidence,
    observe,
    arm() {
      if (phase !== 'idle') return;
      const o = ports.read();
      const refusal = initialRefusal(o);
      if (refusal !== 'none') {
        set('idle', refusal);
        return;
      }
      initialOrientation = o.orientation;
      deadline = o.now + 3000;
      stability.reset();
      stable(o);
      set('arming');
    },
    restore() {
      if (phase !== 'armed') return;
      const o = ports.read();
      if (!ownership(o)) return;
      const settled = stable(o);
      const refusal = o.touches ? 'touch' : o.editable ? 'focus'
        : !rotated ? 'rotation'
        : !validGeometry(o) || o.scale! <= 1.01 ? 'geometry'
        : !settled ? 'unstable' : 'none';
      if (refusal !== 'none') {
        set('armed', refusal);
        return;
      }
      deadline = o.now + 3000;
      set('restoring');
      try {
        ports.back();
      } catch {
        set('error', 'history-error');
      }
    },
  };
}
