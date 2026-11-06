'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

const MESSAGES: Record<string, string> = {
  invalid_link: 'This share link is invalid or has been revoked. Ask the admin who shared it for a new link.',
  not_invited: 'This agent has not been shared with the account you signed in with. Ask an admin to add you, or sign in with the invited account.',
  expired: 'Your access to this agent has expired. Ask an admin to renew it.',
  not_authorized: 'Your account is not allowed to use this service.',
};

export default function ShareLinkPage() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === 'string' ? params.token : '';
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/agent-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'accept', token }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (data?.ok) window.location.replace('/');
        else setError(MESSAGES[data?.error] || 'Could not open this share link. Please try again.');
      } catch {
        if (!cancelled) setError('Could not open this share link. Please try again.');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', background: '#0d1117', color: '#e6edf3' }}>
      <div role={error ? 'alert' : 'status'} style={{ maxWidth: 440, textAlign: 'center', lineHeight: 1.5 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🤖</div>
        {error ? (
          <>
            <p>{error}</p>
            <a href="/" style={{ color: '#58a6ff' }}>Go to Agents Chat</a>
          </>
        ) : <p>Opening shared agent…</p>}
      </div>
    </main>
  );
}
