'use client';

import { useRef } from 'react';
import { useSession } from 'next-auth/react';

export { signOut } from 'next-auth/react';

/**
 * next-auth replaces the session with null when a refetch fails, for example
 * when the tab regains focus while the server is down. Keep the last signed-in
 * session so unsaved messages stay in this user's local outbox (and replay once
 * the server is back) instead of moving to an 'anonymous' outbox nobody reads.
 * A different user signing in still replaces it.
 */
export function useStableSession() {
  const { data, status } = useSession();
  const last = useRef<typeof data>(null);
  if (status === 'authenticated' && data) last.current = data;
  if (status === 'unauthenticated' && last.current) return { data: last.current, status: 'authenticated' as const };
  return { data, status };
}
