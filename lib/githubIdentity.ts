import * as configStore from '@/lib/configStore';
import { resolveUserRole, type UserRole } from '@/lib/auth';

/**
 * Admins list GitHub users by email, but emails can move between GitHub accounts. The first account that signs
 * in with an allowed (verified) email is linked to it; from then on only that account's numeric id, which never
 * changes hands, may use the email. Links disappear once the email has no role, or when an admin resets them.
 */

const RANK: Record<UserRole, number> = { guest: 0, member: 1, admin: 2 };

/** GitHub's id-based noreply address, used for accounts that keep every email private. */
export function githubNoreplyEmail(githubId: string, login: string): string {
  return `${githubId}+${login}@users.noreply.github.com`.toLowerCase();
}

/** The account's verified emails, primary first; null when GitHub could not be asked. */
export async function fetchVerifiedGitHubEmails(accessToken: string): Promise<string[] | null> {
  try {
    const res = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const emails = (await res.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    if (!Array.isArray(emails)) return null;
    return emails
      .filter((entry) => entry?.verified && typeof entry.email === 'string')
      .sort((a, b) => Number(b.primary) - Number(a.primary))
      .map((entry) => entry.email.trim().toLowerCase());
  } catch {
    return null;
  }
}

function roleAs(email: string, githubId: string): UserRole | null {
  return resolveUserRole({ email, provider: 'github', sub: githubId }, configStore.hasAnyAgentAccess);
}

/** Drops links whose email no longer has any role, so re-adding the email later starts a fresh link. */
export function pruneGitHubBindings(): void {
  for (const binding of configStore.listGitHubBindings()) {
    if (!roleAs(binding.email, binding.githubId)) configStore.removeGitHubBinding(binding.email);
  }
}

/**
 * The email this GitHub account signs in as, or null when none of its linked or verified emails has a role.
 * Emails linked to another account are skipped; the highest role wins, preferring already-linked emails.
 */
export function resolveGitHubSignIn(githubId: string, login: string, verifiedEmails: string[]): string | null {
  if (!githubId) return null;
  pruneGitHubBindings();
  const candidates = [...new Set([
    ...configStore.getGitHubBindingsForId(githubId).map((binding) => binding.email),
    ...verifiedEmails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ...(login ? [githubNoreplyEmail(githubId, login)] : []),
  ])];
  let best: { email: string; role: UserRole } | null = null;
  for (const email of candidates) {
    const role = roleAs(email, githubId);
    if (role && (!best || RANK[role] > RANK[best.role])) best = { email, role };
  }
  if (!best || !configStore.bindGitHubEmail(best.email, githubId, login)) return null;
  return best.email;
}
