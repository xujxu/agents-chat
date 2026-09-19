import type { PreventiveProbeEvidence } from '../../../lib/viewportDiagnostics';
import type { AutoObservation, AutoPorts } from './automaticNativeRecovery';
import type { ProbeEvent } from './nativeHistoryProbe';
import { atOriginalScale, consistentGeometry, createViewportStability, validGeometry } from './nativeViewportPolicy.ts';

type PreventivePorts = Omit<AutoPorts, 'publish'> & {
  publish: (evidence: PreventiveProbeEvidence) => void;
};

export function createPreventiveNativeRecovery(ports: PreventivePorts) {
  let phase: PreventiveProbeEvidence['phase'] = 'idle';
  let reason: PreventiveProbeEvidence['reason'] = 'none';
  let intent: PreventiveProbeEvidence['intent'] = 'unknown';
  let cycle = 0;
  let preparations = 0;
  let gestureEpoch = 0;
  let orientationEpoch = 0;
  let gestureOrientationEpoch = 0;
  let pendingAck = false;
  let deadline = 0;
  let previousTouches = 0;
  let sawDeparture = false;
  let direction = ports.read().orientation;
  let lastPublished = '';
  const stability = createViewportStability();
  const continuous = (o: AutoObservation) =>
    o.sameUrl && o.documentContinuous && o.shellContinuous && o.composerContinuous;
  const owned = (o: AutoObservation) =>
    continuous(o) && o.historyLength === 2 && o.entry !== null && o.entryCycle === cycle;
  const overflow = (o: AutoObservation) =>
    !Number.isFinite(o.scrollWidth) || o.scrollWidth > o.clientWidth + 2;
  const evidence = (): PreventiveProbeEvidence => {
    const o = ports.read();
    return {
      phase, reason, intent, cycle, preparations, gestureEpoch, orientationEpoch, pendingAck,
      owned: owned(o), documentContinuous: o.documentContinuous,
      shellContinuous: o.shellContinuous, composerContinuous: o.composerContinuous,
    };
  };
  const publish = () => {
    const next = evidence();
    const key = JSON.stringify(next);
    if (key !== lastPublished) { lastPublished = key; ports.publish(next); }
  };
  const set = (next: PreventiveProbeEvidence['phase'], why: PreventiveProbeEvidence['reason'] = 'none') => {
    phase = next; reason = why; publish();
  };
  const stop = (why: PreventiveProbeEvidence['reason'], error = false) => {
    pendingAck = false;
    set(error ? 'error' : 'stopped', why);
  };
  const canIncrement = (counter: number) => {
    if (counter < 1_000_000) return true;
    stop('counter-limit', true);
    return false;
  };
  const finishGesture = (why: PreventiveProbeEvidence['reason'], nextIntent: PreventiveProbeEvidence['intent'] = 'unknown') => {
    sawDeparture = false;
    intent = nextIntent;
    stability.reset();
    set('watching', why);
  };
  const initialRefusal = (o: AutoObservation): PreventiveProbeEvidence['reason'] => {
    if (!continuous(o)) return 'ownership';
    if (o.historyLength !== 1 || o.entry !== null) return 'fresh-tab';
    if (o.overlay) return 'overlay';
    if (o.touches) return 'touch';
    if (o.editable) return 'focus';
    if (overflow(o)) return 'overflow';
    return atOriginalScale(o) ? 'none' : 'geometry';
  };
  const ready = (o: AutoObservation) =>
    owned(o) && !o.overlay && !o.touches && !o.editable && !overflow(o)
    && o.orientation === direction && atOriginalScale(o);
  const finishPreparation = () => {
    set('rearming');
    const o = ports.read();
    if (!ready(o) || o.entry !== 'checkpoint') { stop('ownership'); return; }
    try {
      ports.rearm();
      cycle++;
      const next = ports.read();
      if (!ready(next) || next.entry !== 'working') { stop('ownership'); return; }
      preparations++;
      finishGesture('none', 'original');
    } catch {
      stop('history-error', true);
    }
  };

  const observe = (event: ProbeEvent = 'tick') => {
    const o = ports.read();
    const startedMulti = o.touches >= 2 && previousTouches < 2;
    const released = o.touches === 0 && previousTouches > 0;
    previousTouches = o.touches;
    const settled = stability.sample(o);
    if (phase === 'stopped' || phase === 'error') { publish(); return; }
    if (event === 'lifecycle' || event === 'navigation') {
      stop(event === 'lifecycle' ? 'lifecycle' : 'ownership'); return;
    }
    if (phase === 'idle') return;
    if (phase === 'arming') {
      if (initialRefusal(o) !== 'none' || event === 'touch' || event === 'popstate'
        || (event === 'orientation' && direction !== o.orientation)) {
        stop('interrupted'); return;
      }
      if (o.now > deadline) { stop('unstable'); return; }
      if (settled) {
        try {
          ports.checkpoint();
          const next = ports.read();
          if (!owned(next) || next.entry !== 'working') { stop('ownership'); return; }
          intent = 'original';
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
      if (!canIncrement(orientationEpoch)) return;
      orientationEpoch++;
      direction = o.orientation;
    }
    if (phase === 'preparing') {
      if (changedDirection || o.orientation !== direction) { stop('superseded'); return; }
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
      if (!pendingAck && settled && atOriginalScale(o)) finishPreparation();
      return;
    }
    if (event === 'popstate' || o.entry !== 'working') { stop('ownership'); return; }
    if (changedDirection || o.orientation !== direction) { finishGesture('superseded'); return; }
    if (o.editable) { finishGesture('focus'); return; }

    if (startedMulti && phase !== 'pinching') {
      if (!canIncrement(gestureEpoch)) return;
      gestureEpoch++;
      gestureOrientationEpoch = orientationEpoch;
      sawDeparture = false;
      intent = 'unknown';
      stability.reset();
      set('pinching');
    }
    if (phase === 'pinching') {
      if (gestureOrientationEpoch !== orientationEpoch) { finishGesture('superseded'); return; }
      if (o.touches >= 2 && validGeometry(o) && Math.abs(o.scale - 1) > 0.01) sawDeparture = true;
      if (released) {
        if (!sawDeparture) { finishGesture('no-scale-change'); return; }
        deadline = o.now + 3000;
        stability.reset();
        stability.sample(o);
        set('assessing-pinch');
      }
      return;
    }
    if (phase === 'assessing-pinch') {
      if (o.touches) { finishGesture('interrupted'); return; }
      if (o.now > deadline) { finishGesture('unassessed'); return; }
      if (settled && atOriginalScale(o)) {
        if (overflow(o)) { finishGesture('overflow'); return; }
        if (!canIncrement(cycle) || !canIncrement(preparations)) return;
        intent = 'original';
        const current = ports.read();
        if (!ready(current) || current.entry !== 'working') { stop('interrupted'); return; }
        pendingAck = true;
        deadline = o.now + 3000;
        set('preparing');
        try { ports.back(); } catch { stop('history-error', true); }
        return;
      }
      if (settled && consistentGeometry(o)) {
        finishGesture('nonunit', 'intentional-nonunit');
        return;
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
