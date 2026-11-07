'use client';

import { useEffect, useState } from 'react';

async function agentAccessAction(body: Record<string, unknown>) {
  const res = await fetch('/api/agent-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/** Admin control for an agent's share link. The link only works for accounts on the access list. */
export function AgentShareLink({ agentId }: { agentId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [note, setNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setNote('');
    agentAccessAction({ action: 'get-link', agentId })
      .then((data) => { if (!cancelled) setToken(data.token ?? null); })
      .catch(() => { if (!cancelled) setNote('Could not load the share link.'); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [agentId]);

  const link = token && typeof window !== 'undefined' ? `${window.location.origin}/invite/${token}` : '';

  async function run(action: 'create-link' | 'revoke-link') {
    if (action === 'create-link' && token && !window.confirm('Reset the link? The current link will stop working and you will need to share the new one.')) return;
    setBusy(true);
    setNote('');
    try {
      const data = await agentAccessAction({ action, agentId });
      setToken(data.token ?? null);
    } catch {
      setNote('Could not update the share link.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setNote('Link copied.');
    } catch {
      setNote('Copy failed; select the link and copy it manually.');
    }
  }

  return (
    <div className="agentShareLink">
      {link ? (
        <div className="agentAccessGrantRow">
          <input readOnly value={link} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="primary inlinePrimary" onClick={() => void copy()} disabled={busy}>Copy link</button>
          <button type="button" className="modalButton" onClick={() => void run('create-link')} disabled={busy} title="Replace this link with a new one, e.g. if it leaked. The old link stops working.">Reset link</button>
          <button type="button" className="modalButton danger" onClick={() => void run('revoke-link')} disabled={busy}>Disable</button>
        </div>
      ) : (
        <button type="button" className="modalButton" onClick={() => void run('create-link')} disabled={busy}>Create share link</button>
      )}
      <p className="agentSectionNote">
        Each agent has one share link for everyone listed below. They must open it while signed in with the listed account. Access lasts 30 days.
      </p>
      {note ? <p role="status" className="agentSectionNote">{note}</p> : null}
    </div>
  );
}
