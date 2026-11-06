import { NextResponse } from 'next/server';
import * as configStore from '@/lib/configStore';
import { canTalkTo, getUserEmail, resolveUserRole, type UserRole } from '@/lib/auth';

/** Server-side role lookup (see `resolveUserRole`); null means the user may not use the app. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getUserRole(token: any): UserRole | null {
  return resolveUserRole(token, configStore.hasAnyAgentAccess);
}

/**
 * Returns a 403 response when the token's role is not in `allowed`, otherwise null. Call it after the
 * route's own 401 check.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function denyRole(token: any, allowed: readonly UserRole[] = ['admin', 'member', 'guest']): NextResponse | null {
  const role = getUserRole(token);
  if (role && allowed.includes(role)) return null;
  return NextResponse.json({ ok: false, error: role ? 'forbidden' : 'not_authorized' }, { status: 403 });
}

/**
 * Whether this user may chat with the agent. Guests only get agents explicitly granted to them (public
 * agents are for members); everyone else follows the per-agent access rule.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canUseAgent(token: any, agent: Pick<configStore.AgentRecord, 'id' | 'owner' | 'public'>): boolean {
  const role = getUserRole(token);
  if (!role) return false;
  if (role === 'guest') return configStore.hasAgentAccess(agent.id, getUserEmail(token));
  return canTalkTo(token, agent.owner || '', agent.id, !!agent.public, configStore.hasAgentAccess);
}

/** Agents this user may chat with, in config order. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function usableAgents(token: any): configStore.AgentRecord[] {
  if (!getUserRole(token)) return [];
  return configStore.getAllAgents().filter((agent) => canUseAgent(token, agent));
}
