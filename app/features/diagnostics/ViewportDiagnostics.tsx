'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createViewportRecorder, parseDiagnosticMode, validateDiagnosticLog,
  type DiagnosticMode, type ViewportDiagnosticLog, type ViewportSample,
} from '../../../lib/viewportDiagnostics';
import { captureViewportSample, initialViewportLog } from './viewportCapture';
import './ViewportDiagnostics.css';

export function ViewportDiagnostics() {
  const [mode, setMode] = useState<DiagnosticMode | null>(null);
  useEffect(() => {
    setMode(parseDiagnosticMode(new URLSearchParams(location.search).get('viewportDiagnostics')));
  }, []);
  return mode ? <DiagnosticPanel mode={mode} /> : null;
}

function DiagnosticPanel({ mode }: { mode: DiagnosticMode }) {
  const snapshotRef = useRef<(() => ViewportDiagnosticLog) | null>(null);
  const retryRef = useRef<ViewportDiagnosticLog | null>(null);
  const uploadingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const [reading, setReading] = useState<{ scale: number | null; count: number; dropped: number }>({
    scale: null, count: 0, dropped: 0,
  });
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const recorder = createViewportRecorder(initialViewportLog(mode));
    const start = performance.now();
    let gesture = false;
    let frame = 0;
    let settle = 0;
    let count = 0;
    const record = (event: ViewportSample['event']) => {
      const sample = captureViewportSample(event, performance.now() - start, gesture);
      recorder.record(sample);
      count++;
      setReading({ scale: sample.metrics.scale, count, dropped: Math.max(0, count - 256) });
    };
    setReading({ scale: recorder.snapshot().initial.metrics.scale, count: 0, dropped: 0 });
    const settled = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(() => record('settled'), 300);
    };
    const queued = (event: 'resize' | 'scroll') => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        record(event);
      });
      settled();
    };
    const resize = () => queued('resize');
    const scroll = () => queued('scroll');
    const orientation = () => { record('orientation'); settled(); };
    const focus = () => { record('focus'); settled(); };
    const touch = (event: TouchEvent) => {
      gesture = event.touches.length >= 2;
      record(event.type === 'touchstart' ? 'touch-start' : event.type === 'touchend' ? 'touch-end' : 'touch-cancel');
      settled();
    };
    const viewport = window.visualViewport;
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('orientationchange', orientation);
    window.addEventListener('focusin', focus);
    window.addEventListener('focusout', focus);
    for (const name of ['touchstart', 'touchend', 'touchcancel'] as const) {
      window.addEventListener(name, touch, { passive: true });
    }
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', scroll);
    snapshotRef.current = () => { record('upload'); return recorder.snapshot(); };
    return () => {
      snapshotRef.current = null;
      controllerRef.current?.abort();
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('orientationchange', orientation);
      window.removeEventListener('focusin', focus);
      window.removeEventListener('focusout', focus);
      for (const name of ['touchstart', 'touchend', 'touchcancel'] as const) window.removeEventListener(name, touch);
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', scroll);
    };
  }, [mode]);

  const upload = async () => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    setUploading(true);
    setFailed(false);
    setStatus('Uploading diagnostic log...');
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const log = retryRef.current ?? snapshotRef.current?.();
      if (!log) throw new Error('Recorder is not ready. Please retry.');
      retryRef.current = log;
      if (!validateDiagnosticLog(log)) throw new Error('Diagnostic data is outside the permitted schema. Reload the diagnostic page and retry.');
      const response = await fetch('/api/diagnostics/viewport', {
        method: 'POST', credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(log),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = typeof result === 'object' && result !== null && 'message' in result
          && typeof result.message === 'string' ? result.message : `Upload failed (${response.status}).`;
        throw new Error(message);
      }
      if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true
        || !('id' in result) || typeof result.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.id)) {
        throw new Error('Server did not confirm a saved diagnostic log.');
      }
      retryRef.current = null;
      setStatus(`Saved log: ${result.id}`);
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : 'Upload failed. Please retry.');
    } finally {
      window.clearTimeout(timeout);
      controllerRef.current = null;
      uploadingRef.current = false;
      setUploading(false);
    }
  };

  return (
    <aside className="viewportDiagnostics" aria-label="Viewport diagnostics" data-mode={mode}>
      <div className="viewportDiagnosticsHeading">
        <strong>Viewport / {mode}</strong>
        <output aria-label="Recorded scale" aria-live="off">{reading.scale === null ? 'unavailable' : `${reading.scale}x`}</output>
      </div>
      <div className="viewportDiagnosticsHint">
        {reading.count} events{reading.dropped ? ` / ${reading.dropped} older samples dropped` : ''}. No chat text collected.
      </div>
      <button type="button" onClick={upload} disabled={uploading}>
        {uploading ? 'Uploading...' : failed ? 'Retry upload' : 'Upload diagnostic log'}
      </button>
      <div className="viewportDiagnosticsStatus" role="status" aria-live="polite" data-error={failed}>
        {status || 'Reproduce the issue, then upload.'}
      </div>
    </aside>
  );
}
