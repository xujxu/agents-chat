import type { AutoProbeEvidence } from '../../../lib/viewportDiagnostics';
import type { ProbeEvent, ProbeObservation } from './nativeHistoryProbe';
import { atOriginalScale, consistentGeometry, createViewportStability } from './nativeViewportPolicy.ts';

export type AutoObservation = ProbeObservation & {
  scrollWidth: number;
  overlay: boolean;
  entryCycle: number | null;
};
export type AutoPorts = {
  read: () => AutoObservation;
  checkpoint: () => void;
  back: () => void;
  rearm: () => void;
  publish: (evidence: AutoProbeEvidence) => void;
};

export function createAutomaticNativeRecovery(ports: AutoPorts) {
  let phase: AutoProbeEvidence['phase'] = 'idle';
  let reason: AutoProbeEvidence['reason'] = 'none';
  let intent: AutoProbeEvidence['intent'] = 'unknown';
  let cycle = 0;
  let corrections = 0;
  let orientationEpoch = 0;
  let originalIntentEpoch = 0;
  let pendingAck = false;
  let deadline = 0;
  let boundaryTime = -Infinity;
  let direction = ports.read().orientation;
  let previousTouches = 0;
  let previousEditable = false;
  let learningIntent = false;
  let gestureEpoch = 0;
  let focusBaselinePending = false;
  let lastPublished = '';
  const stability = createViewportStability();
  const rememberOriginalIntent = () => {
    intent = 'original';
    originalIntentEpoch = orientationEpoch;
  };
  const continuous = (o: AutoObservation) =>
    o.sameUrl && o.documentContinuous && o.shellContinuous && o.composerContinuous;
  const owned = (o: AutoObservation) =>
    continuous(o) && o.historyLength === 2 && o.entry !== null && o.entryCycle === cycle;
  const evidence = (): AutoProbeEvidence => {
    const o = ports.read();
    return {
      phase, reason, intent, cycle, corrections, orientationEpoch, pendingAck,
      owned: owned(o), documentContinuous: o.documentContinuous,
      shellContinuous: o.shellContinuous, composerContinuous: o.composerContinuous,
    };
  };
  const publish = () => {
    const next = evidence();
    const key = JSON.stringify(next);
    if (key !== lastPublished) { lastPublished = key; ports.publish(next); }
  };
  const set = (next: AutoProbeEvidence['phase'], why: AutoProbeEvidence['reason'] = 'none') => {
    phase = next; reason = why;
    publish();
  };
  const stop = (why: AutoProbeEvidence['reason'], error = false) => {
    pendingAck = false;
    set(error ? 'error' : 'stopped', why);
  };
  const initialRefusal = (o: AutoObservation): AutoProbeEvidence['reason'] => {
    if (!continuous(o)) return 'ownership';
    if (o.historyLength !== 1 || o.entry !== null) return 'fresh-tab';
    if (o.overlay) return 'overlay';
    if (o.touches) return 'touch';
    if (o.editable) return 'focus';
    if (!Number.isFinite(o.scrollWidth) || o.scrollWidth > o.clientWidth + 2) return 'overflow';
    return atOriginalScale(o) ? 'none' : 'geometry';
  };
  const finishRecovery = () => {
    corrections++;
    set('rearming');
    const o = ports.read();
    if (!owned(o) || o.entry !== 'checkpoint' || o.overlay || o.touches || o.editable || !atOriginalScale(o)) {
      stop('ownership');
      return;
    }
    try {
      ports.rearm();
      cycle++;
      const next = ports.read();
      if (!owned(next) || next.entry !== 'working') { stop('ownership'); return; }
      rememberOriginalIntent();
      learningIntent = false;
      focusBaselinePending = false;
      direction = next.orientation;
      stability.reset();
      stability.sample(next);
      set('watching');
    } catch {
      stop('history-error', true);
    }
  };

  const observe = (event: ProbeEvent = 'tick') => {
    const o = ports.read();
    let settled = stability.sample(o);
    if (phase === 'stopped' || phase === 'error') { publish(); return; }
    if (event === 'lifecycle' || event === 'navigation') {
      stop(event === 'lifecycle' ? 'lifecycle' : 'ownership'); return;
    }
    if (phase === 'idle') return;
    if (phase === 'arming') {
      if (initialRefusal(o) !== 'none' || event === 'touch' || event === 'popstate'
        || (event === 'orientation' && o.orientation !== direction)) {
        stop('interrupted'); return;
      }
      if (o.now > deadline) { stop('unstable'); return; }
      if (settled) {
        try {
          ports.checkpoint();
          if (!owned(ports.read()) || ports.read().entry !== 'working') { stop('ownership'); return; }
          rememberOriginalIntent();
          set('watching');
        } catch {
          stop('history-error', true);
        }
      }
      return;
    }
    if (!owned(o)) { stop('ownership'); return; }
    if (o.overlay) { stop('overlay'); return; }

    const changedDirection = event === 'orientation' && direction !== o.orientation;
    if (changedDirection) {
      direction = o.orientation;
      orientationEpoch++;
      boundaryTime = o.now;
    }
    if (phase === 'restoring') {
      if (changedDirection) { stop('superseded'); return; }
      if (o.touches || o.editable) { stop('interrupted'); return; }
      if (o.now > deadline) { stop(pendingAck ? 'ack-timeout' : 'scale-timeout', true); return; }
      if (event === 'popstate') {
        if (!pendingAck || o.entry !== 'checkpoint') { stop('ownership'); return; }
        pendingAck = false;
        deadline = o.now + 3000;
        stability.reset();
        publish();
        return;
      }
      if (!pendingAck && o.entry !== 'checkpoint') { stop('ownership'); return; }
      if (!pendingAck && settled && atOriginalScale(o)) finishRecovery();
      return;
    }
    if (event === 'popstate' || o.entry !== 'working') { stop('ownership'); return; }

    if (o.touches >= 2 && previousTouches < 2) {
      learningIntent = true; gestureEpoch = orientationEpoch; intent = 'unknown';
      stability.reset();
      settled = false;
    }
    if (learningIntent && previousTouches > 0 && o.touches === 0) {
      stability.reset();
      stability.sample(o);
      settled = false;
    }
    previousTouches = o.touches;
    if (o.editable) {
      intent = 'unknown'; focusBaselinePending = true; learningIntent = false;
    }
    if (previousEditable && !o.editable) {
      stability.reset();
      stability.sample(o);
      settled = false;
    }
    previousEditable = o.editable;
    if (phase === 'assessing-rotation' && (o.touches || o.editable)) {
      set('watching', o.editable ? 'focus' : 'interrupted');
      return;
    }
    if (phase === 'watching' && settled && consistentGeometry(o)) {
      if (learningIntent && gestureEpoch === orientationEpoch) {
        if (atOriginalScale(o)) rememberOriginalIntent();
        else intent = 'intentional-nonunit';
        learningIntent = false;
        reason = intent === 'original' ? 'none' : 'nonunit';
      } else if (focusBaselinePending && o.now > boundaryTime + 3000 && atOriginalScale(o)) {
        rememberOriginalIntent(); focusBaselinePending = false; reason = 'none';
      } else if (intent === 'original' && originalIntentEpoch === orientationEpoch
        && o.orientation === direction && !changedDirection && o.scale !== null && o.scale > 1.01) {
        intent = 'unknown'; reason = 'intent-unknown';
      }
    }
    if (changedDirection) {
      if (intent !== 'original' || o.touches || o.editable) {
        set('watching', intent === 'intentional-nonunit' ? 'nonunit' : 'unassessed');
        return;
      }
      deadline = o.now + 3000;
      stability.reset();
      stability.sample(o);
      set('assessing-rotation');
      return;
    }
    if (phase === 'assessing-rotation') {
      if (o.now > deadline) { set('watching', 'unassessed'); return; }
      if (settled && consistentGeometry(o)) {
        if (!Number.isFinite(o.scrollWidth) || o.scrollWidth > o.clientWidth + 2) {
          set('watching', 'overflow'); return;
        }
        if (atOriginalScale(o)) { rememberOriginalIntent(); set('watching'); return; }
        if (o.scale !== null && o.scale > 1.01) {
          pendingAck = true;
          deadline = o.now + 3000;
          set('restoring');
          try { ports.back(); } catch { stop('history-error', true); }
          return;
        }
      }
    }
    publish();
  };

  return {
    observe, evidence,
    arm() {
      if (phase !== 'idle') return;
      const o = ports.read();
      const refusal = initialRefusal(o);
      if (refusal !== 'none') { set('idle', refusal); return; }
      direction = o.orientation;
      deadline = o.now + 3000;
      stability.reset(); stability.sample(o);
      set('arming');
    },
    stop() { stop('stopped-by-user'); },
  };
}
