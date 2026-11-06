import { getToken } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

/**
 * Shared authentication and permission helpers.
 */

export function parseEmailList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function getGitHubAllowedEmails(
  githubAllowedEmails: string | undefined,
  adminEmails: string | undefined,
): string[] {
  const explicit = parseEmailList(githubAllowedEmails);
  return explicit.length > 0 ? explicit : parseEmailList(adminEmails);
}

export function isGitHubEmailAllowed(email: string | undefined, allowedEmails: string[]): boolean {
  const normalizedEmail = email?.trim().toLowerCase();
  return Boolean(normalizedEmail && allowedEmails.includes(normalizedEmail));
}

export function shouldUseSecureAuthCookies(
  nextAuthUrl: string | undefined,
  nodeEnv: string | undefined,
): boolean {
  return nextAuthUrl ? nextAuthUrl.startsWith('https://') : nodeEnv === 'production';
}

/**
 * Roles granted in the admin UI live in SQLite (`configStore.user_roles`). This module stays free of the DB
 * import, so configStore registers its lookup here when it loads. Kept on globalThis so every server bundle
 * that imports this module sees the same lookup.
 */
type DbRoleLookup = (email: string) => 'admin' | 'member' | null;
const roleLookupHolder = globalThis as unknown as { __agentsChatDbRoleLookup?: DbRoleLookup };

export function setDbRoleLookup(lookup: DbRoleLookup | null): void {
  roleLookupHolder.__agentsChatDbRoleLookup = lookup ?? undefined;
}

export function getDbRole(email: string | undefined): 'admin' | 'member' | null {
  const normalized = (email || '').trim().toLowerCase();
  const lookup = roleLookupHolder.__agentsChatDbRoleLookup;
  if (!normalized || !lookup) return null;
  try {
    return lookup(normalized);
  } catch {
    return null;
  }
}

export function isEnvAdminEmail(email: string | undefined): boolean {
  const normalized = (email || '').trim().toLowerCase();
  return Boolean(normalized) && parseEmailList(process.env.ADMIN_EMAILS).includes(normalized);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isAdminToken(token: any): boolean {
  if (!token) return false;
  if (token.sub === 'admin') return true;
  // The role claim is never trusted on its own (older OAuth cookies carry no provider and could keep a revoked
  // admin claim), so every other token is re-evaluated against env and the UI roles.
  const email = ((token.email as string) || '').toLowerCase();
  if (!email) return false;
  return isEnvAdminEmail(email) || getDbRole(email) === 'admin';
}

/**
 * Global roles: `admin` (ADMIN_EMAILS, the admin login, or granted in the UI) can do everything; `member`
 * (MEMBER_EMAILS, GITHUB_ALLOWED_EMAILS, or granted in the UI) can create agents and use public, own and
 * granted agents; `guest` (anyone else with at least one agent access grant) can only use the agents
 * granted to them.
 */
export type UserRole = 'admin' | 'member' | 'guest';

/**
 * MEMBER_EMAILS entries are emails, `@domain` suffixes or `*` (see `memberEmailsFor` for where `*` applies).
 * GITHUB_ALLOWED_EMAILS entries are members too, since that list already granted full access.
 */
export function isMemberEmail(
  email: string | undefined,
  memberEmails: string | undefined = process.env.MEMBER_EMAILS,
  githubAllowedEmails: string | undefined = process.env.GITHUB_ALLOWED_EMAILS,
): boolean {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) return false;
  if (parseEmailList(githubAllowedEmails).includes(normalized)) return true;
  return parseEmailList(memberEmails).some((pattern) => pattern === '*'
    || pattern === normalized
    || (pattern.startsWith('@') && normalized.endsWith(pattern)));
}

const MULTI_TENANT_ENTRA_IDS = new Set(['', 'common', 'organizations', 'consumers']);

/** Whether AZURE_AD_TENANT_ID names one tenant, so Entra only admits that tenant's accounts. */
export function isPinnedEntraTenant(tenantId: string | undefined = process.env.AZURE_AD_TENANT_ID): boolean {
  return !MULTI_TENANT_ENTRA_IDS.has((tenantId || '').trim().toLowerCase());
}

/**
 * MEMBER_EMAILS as it applies to this sign-in. The `*` wildcard admits every account of the pinned Entra
 * tenant; it is dropped for GitHub (anyone can create an account) and when Entra is multi-tenant (any
 * Microsoft account, with an email claim the user's own tenant controls).
 */
export function memberEmailsFor(
  provider: string | undefined,
  memberEmails: string | undefined = process.env.MEMBER_EMAILS,
  tenantId: string | undefined = process.env.AZURE_AD_TENANT_ID,
): string {
  const entries = parseEmailList(memberEmails);
  const wildcardAllowed = provider !== 'github' && isPinnedEntraTenant(tenantId);
  return (wildcardAllowed ? entries : entries.filter((entry) => entry !== '*')).join(',');
}

/** The user's role, or null when they may not use the app at all. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveUserRole(token: any, hasAnyAgentAccess: (email: string) => boolean): UserRole | null {
  if (!token) return null;
  if (isAdminToken(token)) return 'admin';
  const email = getUserEmail(token);
  if (!email) return null;
  if (isMemberEmail(email, memberEmailsFor(token.provider))) return 'member';
  if (getDbRole(email) === 'member') return 'member';
  return hasAnyAgentAccess(email) ? 'guest' : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getUserEmail(token: any): string {
  if (!token) return '';
  return ((token.email as string) || '').toLowerCase();
}

/**
 * Check if a token holder can modify a resource owned by `ownerEmail`.
 * Admin can modify anything. Owner can modify their own resources.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canModify(token: any, ownerEmail: string): boolean {
  if (isAdminToken(token)) return true;
  const email = getUserEmail(token);
  return email !== '' && email === ownerEmail.toLowerCase();
}

/**
 * Get the auth token from a Next.js request.
 */
export async function getAuthToken(req: NextRequest) {
  return getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
}

/**
 * Check if a token holder can talk to an agent.
 * Public agents: anyone can talk. Otherwise: admin, owner, or allowlisted user.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canTalkTo(token: any, agentOwner: string, agentId: string, isPublic: boolean, hasAccess: (agentId: string, email: string) => boolean): boolean {
  if (isPublic) return true;
  if (isAdminToken(token)) return true;
  const email = getUserEmail(token);
  if (!email) return false;
  if (email === agentOwner.toLowerCase()) return true;
  return hasAccess(agentId, email);
}
