'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type Grant = {
  agentId: string;
  agentName: string;
  expiresAt: string;
  status: 'pending' | 'active' | 'expired';
  extensionDays: number | null;
};
type ExtensionRequest = { agentId: string; agentName: string; email: string; extensionDays: number };
type Notice = { key: string; text: string; actions: { label: string; run: () => Promise<void> }[] };

const POLL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function post(body: Record<string, unknown>) {
  const res = await fetch('/api/agent-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
}

/** In-app notices: shared agents about to expire (recipients) and pending extension requests (admins). */
export function AccessNoticesBanner() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/agent-access', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data?.ok) return;
      const remindMs = (Number(data.remindDays) || 3) * DAY_MS;
      const next: Notice[] = [];
      for (const g of (data.grants || []) as Grant[]) {
        if (g.status === 'pending') continue;
        const msLeft = new Date(g.expiresAt).getTime() - Date.now();
        if (msLeft > remindMs) continue;
        const when = msLeft <= 0 ? 'has expired' : `expires in ${Math.max(1, Math.ceil(msLeft / DAY_MS))} day(s)`;
        next.push({
          key: `grant:${g.agentId}:${g.expiresAt}:${g.extensionDays ?? ''}`,
          text: `Your access to "${g.agentName}" ${when}.${g.extensionDays ? ' Extension requested.' : ''}`,
          actions: g.extensionDays ? [] : [{ label: 'Request 30 more days', run: () => post({ action: 'request-extension', agentId: g.agentId, days: 30 }) }],
        });
      }
      for (const r of (data.extensionRequests || []) as ExtensionRequest[]) {
        next.push({
          key: `request:${r.agentId}:${r.email}:${r.extensionDays}`,
          text: `${r.email} asked for ${r.extensionDays} more days on "${r.agentName}".`,
          actions: [
            { label: 'Approve', run: () => post({ action: 'approve-extension', agentId: r.agentId, email: r.email }) },
            { label: 'Deny', run: () => post({ action: 'deny-extension', agentId: r.agentId, email: r.email }) },
          ],
        });
      }
      setNotices(next);
    } catch {
      // Notices are best-effort; the rest of the app keeps working without them.
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const visible = notices.filter((n) => !dismissed.has(n.key));
  if (!mounted || visible.length === 0) return null;

  return createPortal(
    <div className="accessNotices" role="region" aria-label="Agent access notices" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 380 }}>
      {visible.map((n) => (
        <div key={n.key} role="status" style={{ background: '#1f2937', color: '#f3f4f6', border: '1px solid #f59e0b', borderRadius: 8, padding: '10px 12px', fontSize: 13, boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ flex: 1 }}>{n.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setDismissed((d) => new Set(d).add(n.key))} style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button>
          </div>
          {n.actions.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {n.actions.map((a) => (
                <button key={a.label} type="button" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try { await a.run(); } catch { /* the next load shows the current state */ }
                  await load();
                  setBusy(false);
                }}>{a.label}</button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
