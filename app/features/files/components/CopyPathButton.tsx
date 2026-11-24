'use client';

import { useEffect, useState } from 'react';

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  }
  // The async clipboard API is missing on plain-http hosts.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  Object.assign(area.style, { position: 'fixed', top: '0', left: '-10000px', opacity: '0' });
  document.body.appendChild(area);
  area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
}

export function CopyPathButton({ path, label = 'Copy full path', className = '' }: { path: string; label?: string; className?: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [copyState]);
  useEffect(() => setCopyState('idle'), [path]);

  const copyLabel = copyState === 'copied' ? 'Copied path' : copyState === 'failed' ? 'Copy failed' : label;
  return (
    <button
      type="button"
      className={`mdPathCopy ${copyState} ${className}`.trim()}
      aria-label={copyLabel}
      title={copyState === 'idle' ? `${label}: ${path}` : copyLabel}
      onClick={() => void copyText(path).then(ok => setCopyState(ok ? 'copied' : 'failed'))}
    >
      {copyState === 'copied' ? '✓' : copyState === 'failed' ? '!' : '⧉'}
    </button>
  );
}
