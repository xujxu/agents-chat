'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Role = 'admin' | 'member' | 'guest';
type Source = 'env' | 'ui' | 'grant';
type UserEntry = {
  email: string;
  role: Role;
  sources: Source[];
  uiRole: 'admin' | 'member' | null;
  grantedBy?: string;
  agents: { id: string; name: string }[];
};
type UsersResponse = {
  ok: boolean;
  error?: string;
  me?: string;
  users?: UserEntry[];
  envPatterns?: { admins: string[]; members: string[] };
};

const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', member: 'Member', guest: 'Guest' };
const SOURCE_LABEL: Record<Source, string> = { env: 'env', ui: 'UI', grant: 'agent grant' };
const ERROR_TEXT: Record<string, string> = {
  invalid_email: 'Enter a valid email address.',
  invalid_role: 'Choose Admin or Member.',
  cannot_change_own_role: 'You cannot change your own role.',
  managed_by_env: 'This admin is set in ADMIN_EMAILS; change it in the server env.',
  not_found: 'That user has no UI role.',
  forbidden: 'Only admins can manage roles.',
};

export type UsersRolesDialogProps = { onClose: () => void };

export function UsersRolesDialog({ onClose }: UsersRolesDialogProps) {
  const [data, setData] = useState<UsersResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');

  const apply = useCallback(async (res: Response) => {
    const body = (await res.json().catch(() => ({ ok: false, error: 'request_failed' }))) as UsersResponse;
    if (!res.ok || !body.ok) {
      setError(ERROR_TEXT[body.error || ''] || `Request failed (${body.error || res.status}).`);
      return false;
    }
    setError('');
    setData(body);
    return true;
  }, []);

  useEffect(() => {
    void fetch('/api/users', { cache: 'no-store' }).then(apply).catch(() => setError('Could not load users.'));
  }, [apply]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setUserRole = async (targetEmail: string, targetRole: 'admin' | 'member') => {
    setBusy(true);
    try {
      return await apply(await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, role: targetRole }),
      }));
    } catch {
      setError('Could not save the role.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const removeUserRole = async (targetEmail: string) => {
    if (!window.confirm(`Remove the UI role for ${targetEmail}?`)) return;
    setBusy(true);
    try {
      await apply(await fetch(`/api/users?email=${encodeURIComponent(targetEmail)}`, { method: 'DELETE' }));
    } catch {
      setError('Could not remove the role.');
    } finally {
      setBusy(false);
    }
  };

  const onAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (await setUserRole(email.trim(), role)) setEmail('');
  };

  const me = (data?.me || '').toLowerCase();
  const patterns = data?.envPatterns;

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modal usersRolesModal" role="dialog" aria-modal="true" aria-labelledby="usersRolesTitle" onClick={(e) => e.stopPropagation()}>
        <h2 id="usersRolesTitle">Users &amp; roles</h2>
        <p className="usersRolesHint">
          Roles set here take effect immediately. Env roles (ADMIN_EMAILS, MEMBER_EMAILS) are read-only here; guests come from per-agent Access control grants.
        </p>

        <form className="usersRolesAdd" onSubmit={(event) => void onAdd(event)}>
          <input
            type="email"
            placeholder="user@example.com"
            aria-label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            required
          />
          <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')} disabled={busy}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit" className="primary" disabled={busy || !email.trim()}>Add</button>
        </form>

        {error ? <p className="usersRolesError" role="alert">{error}</p> : null}

        {!data ? (
          !error ? <p className="muted">Loading…</p> : null
        ) : (
          <ul className="usersRolesList">
            {(data.users || []).map((user) => {
              const isMe = user.email === me;
              const envAdmin = user.sources.includes('env') && user.role === 'admin' && user.uiRole !== 'admin';
              return (
                <li key={user.email} className="usersRolesItem">
                  <div className="usersRolesIdentity">
                    <span className="usersRolesEmail">{user.email}{isMe ? ' (you)' : ''}</span>
                    <span className="usersRolesMeta">
                      <span className={`usersRolesBadge role-${user.role}`}>{ROLE_LABEL[user.role]}</span>
                      {user.sources.map((source) => <span key={source} className="usersRolesSource">{SOURCE_LABEL[source]}</span>)}
                      {user.agents.length ? <span className="usersRolesAgents" title={user.agents.map((a) => a.name).join(', ')}>{user.agents.length} agent{user.agents.length === 1 ? '' : 's'}</span> : null}
                    </span>
                  </div>
                  {!isMe && !envAdmin ? (
                    <div className="usersRolesActions">
                      <select
                        aria-label={`UI role for ${user.email}`}
                        value={user.uiRole || ''}
                        disabled={busy}
                        onChange={(e) => {
                          const next = e.target.value;
                          if (next === 'admin' || next === 'member') void setUserRole(user.email, next);
                          else if (user.uiRole) void removeUserRole(user.email);
                        }}
                      >
                        <option value="">{user.uiRole ? 'Remove UI role' : '— no UI role —'}</option>
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {patterns && patterns.members.length ? (
          <p className="usersRolesHint">Env member patterns: {patterns.members.join(', ')}</p>
        ) : null}

        <div className="modalActions">
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
