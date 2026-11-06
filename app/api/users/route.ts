import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import * as configStore from '@/lib/configStore';
import { getUserEmail, isEnvAdminEmail, isMemberEmail, parseEmailList } from '@/lib/auth';
import { denyRole } from '@/lib/rbac';
import { createLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
const logger = createLogger('api.users');

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const ROLES = ['admin', 'member'] as const;

type Source = 'env' | 'ui' | 'grant';
type UserEntry = {
  email: string;
  role: 'admin' | 'member' | 'guest';
  sources: Source[];
  /** Role stored in the UI table, if any; only this part can be changed here. */
  uiRole: 'admin' | 'member' | null;
  grantedBy?: string;
  updatedAt?: string;
  agents: { id: string; name: string }[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function requireAdmin(req: NextRequest): Promise<{ token: any } | { response: NextResponse }> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return { response: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }) };
  const denied = denyRole(token, ['admin']);
  if (denied) return { response: denied };
  return { token };
}

const RANK = { guest: 0, member: 1, admin: 2 } as const;

function listUsers(): { users: UserEntry[]; envPatterns: { admins: string[]; members: string[] } } {
  const envAdmins = parseEmailList(process.env.ADMIN_EMAILS);
  const envMemberEntries = [...new Set([
    ...parseEmailList(process.env.MEMBER_EMAILS),
    ...parseEmailList(process.env.GITHUB_ALLOWED_EMAILS),
  ])];
  const agentNames = new Map(configStore.getAllAgents().map((agent) => [agent.id, agent.name || agent.id]));
  const users = new Map<string, UserEntry>();
  const entry = (email: string): UserEntry => {
    let user = users.get(email);
    if (!user) {
      user = { email, role: 'guest', sources: [], uiRole: null, agents: [] };
      users.set(email, user);
    }
    return user;
  };
  const add = (user: UserEntry, source: Source, role: UserEntry['role']) => {
    if (!user.sources.includes(source)) user.sources.push(source);
    if (RANK[role] > RANK[user.role]) user.role = role;
  };

  for (const email of envAdmins) add(entry(email), 'env', 'admin');
  for (const email of envMemberEntries.filter((e) => EMAIL_RE.test(e))) add(entry(email), 'env', 'member');
  for (const record of configStore.listUserRoles()) {
    const user = entry(record.email);
    add(user, 'ui', record.role);
    user.uiRole = record.role;
    user.grantedBy = record.grantedBy;
    user.updatedAt = record.updatedAt;
  }
  for (const grant of configStore.listAllAgentAccess()) {
    const user = entry(grant.email);
    // A MEMBER_EMAILS domain pattern can make a grantee a member.
    add(user, 'grant', isMemberEmail(grant.email) ? 'member' : 'guest');
    user.agents.push({ id: grant.agentId, name: agentNames.get(grant.agentId) || grant.agentId });
  }
  const sorted = [...users.values()].sort((a, b) => RANK[b.role] - RANK[a.role] || a.email.localeCompare(b.email));
  // Domain and wildcard patterns can't be listed as users, so they are reported separately.
  return { users: sorted, envPatterns: { admins: envAdmins, members: envMemberEntries.filter((e) => !EMAIL_RE.test(e)) } };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  return NextResponse.json({ ok: true, me: getUserEmail(auth.token), ...listUsers() });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  const body = await req.json().catch(() => ({}));
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = body?.role;
  if (email.length > 254 || !EMAIL_RE.test(email)) return NextResponse.json({ ok: false, error: 'invalid_email' }, { status: 400 });
  if (!ROLES.includes(role)) return NextResponse.json({ ok: false, error: 'invalid_role' }, { status: 400 });
  const me = getUserEmail(auth.token);
  if (email === me) return NextResponse.json({ ok: false, error: 'cannot_change_own_role' }, { status: 400 });
  if (isEnvAdminEmail(email)) return NextResponse.json({ ok: false, error: 'managed_by_env' }, { status: 409 });
  configStore.setUserRole(email, role, me || 'admin');
  logger.info({ email, role, by: me }, 'user role set');
  return NextResponse.json({ ok: true, me, ...listUsers() });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  const email = (req.nextUrl.searchParams.get('email') || '').trim().toLowerCase();
  if (!email) return NextResponse.json({ ok: false, error: 'invalid_email' }, { status: 400 });
  const me = getUserEmail(auth.token);
  if (email === me) return NextResponse.json({ ok: false, error: 'cannot_change_own_role' }, { status: 400 });
  if (!configStore.removeUserRole(email)) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  logger.info({ email, by: me }, 'user role removed');
  return NextResponse.json({ ok: true, me, ...listUsers() });
}
