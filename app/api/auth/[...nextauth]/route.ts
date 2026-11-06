import { timingSafeEqual } from 'crypto';
import NextAuth, { type AuthOptions } from 'next-auth';
import AzureADProvider from 'next-auth/providers/azure-ad';
import GitHubProvider from 'next-auth/providers/github';
import CredentialsProvider from 'next-auth/providers/credentials';
import { type NextRequest } from 'next/server';
import {
  getDbRole,
  getGitHubAllowedEmails,
  isEnvAdminEmail,
  memberEmailsFor,
  resolveUserRole,
  shouldUseSecureAuthCookies,
} from '@/lib/auth';
import { hasAnyAgentAccess, listUserRoles } from '@/lib/configStore';
import { fetchVerifiedGitHubEmails, resolveGitHubSignIn } from '@/lib/githubIdentity';

/** Constant-time string comparison to prevent timing attacks. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self so we still spend constant time,
    // but always return false for mismatched lengths.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

const providers: AuthOptions['providers'] = [];

if (process.env.AZURE_AD_CLIENT_ID) {
  providers.push(
    AzureADProvider({
      clientId: process.env.AZURE_AD_CLIENT_ID,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET || ' ',
      tenantId: process.env.AZURE_AD_TENANT_ID ?? 'common',
      authorization: {
        params: { scope: 'openid profile email User.Read' },
      },
      checks: ['pkce'],
      client: { token_endpoint_auth_method: 'none' },
      profile(profile) {
        return {
          id: profile.sub || profile.oid,
          name: profile.name || profile.preferred_username,
          email: profile.email || profile.preferred_username || profile.upn,
        };
      },
    }),
  );
}

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  providers.push(
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      authorization: { params: { scope: 'read:user user:email' } },
      profile(profile, tokens) {
        return {
          id: String(profile.id),
          name: profile.name || profile.login,
          // GitHub's own noreply form: the numeric id never changes hands, unlike a login that can be
          // renamed and re-registered by someone else.
          email: profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`,
          image: profile.avatar_url,
          // Stash the OAuth access token so we can fetch primary email later
          // if the profile.email is null (private email setting).
          ghAccessToken: tokens?.access_token,
          ghLogin: profile.login,
        } as any;
      },
    }),
  );
}

providers.push(
  CredentialsProvider({
    id: 'admin-login',
    name: 'Admin',
    credentials: {
      username: { label: 'Username', type: 'text' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(credentials) {
      const adminUser = process.env.ADMIN_USERNAME;
      const adminPass = process.env.ADMIN_PASSWORD;
      // Disable credentials login when either env var is missing
      if (!adminUser || !adminPass) return null;
      if (
        credentials?.username &&
        credentials?.password &&
        safeEqual(credentials.username, adminUser) &&
        safeEqual(credentials.password, adminPass)
      ) {
        return { id: 'admin', name: 'Admin', email: 'admin@local', role: 'admin' };
      }
      return null;
    },
  }),
);

const secureAuthCookies = shouldUseSecureAuthCookies(
  process.env.NEXTAUTH_URL,
  process.env.NODE_ENV,
);

export const authOptions: AuthOptions = {
  debug: true,
  providers,
  pages: { signIn: '/login' },
  session: { strategy: 'jwt' },
  cookies: {
    csrfToken: {
      name: 'next-auth.csrf-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: secureAuthCookies,
      },
    },
    callbackUrl: {
      name: 'next-auth.callback-url',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: secureAuthCookies,
      },
    },
    state: {
      name: 'next-auth.state',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: secureAuthCookies,
      },
    },
    pkceCodeVerifier: {
      name: 'next-auth.pkce.code_verifier',
      options: {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: secureAuthCookies,
      },
    },
    sessionToken: {
      name: 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: secureAuthCookies,
      },
    },
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (!account || account.provider === 'admin-login') return true;

      let email = typeof profile?.email === 'string' ? profile.email : '';
      if (account.provider === 'github') {
        const githubId = String(account.providerAccountId || user.id || '');
        const login = String((profile as { login?: unknown } | undefined)?.login || (user as { ghLogin?: unknown }).ghLogin || '');
        // GitHub only publishes verified emails on the profile, so that is a safe fallback if the API call fails.
        const verified = (account.access_token ? await fetchVerifiedGitHubEmails(account.access_token) : null)
          ?? (email ? [email] : []);
        const resolved = resolveGitHubSignIn(githubId, login, verified);
        if (resolved) {
          // NextAuth hands this same user object to the jwt callback, which makes it the session's email.
          user.email = resolved;
          return true;
        }
        const allowedEmails = getGitHubAllowedEmails(
          process.env.GITHUB_ALLOWED_EMAILS,
          process.env.ADMIN_EMAILS,
        );
        return allowedEmails.length === 0 && !memberEmailsFor('github') && listUserRoles().length === 0
          ? '/login?error=GitHubAllowlistNotConfigured'
          : false;
      }

      email = email || user.email || '';
      return resolveUserRole({ email, provider: account.provider }, hasAnyAgentAccess) ? true : '/login?error=NotAuthorized';
    },
    async jwt({ token, user, account }) {
      // signIn chose (and linked) the GitHub account's email; the token's sub is the account's numeric id.
      if (account?.provider === 'github' && user?.email) token.email = user.email.toLowerCase();
      if (account?.provider) token.provider = account.provider;
      if (user && (user as any).role === 'admin') {
        // Credentials login with role=admin → always admin
        token.role = 'admin';
      } else if (token.sub !== 'admin') {
        // Azure AD / OAuth users: ADMIN_EMAILS or an admin role granted in the UI. Re-evaluated on every
        // session refresh so role changes take effect without signing out. Azure AD may populate the
        // email on the token (from the id_token) rather than the user object.
        const email = (token.email || user?.email || '').toString().toLowerCase();
        token.role = email && (isEnvAdminEmail(email) || getDbRole(email) === 'admin') ? 'admin' : 'user';
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).role = token.role ?? 'user';
      }
      return session;
    },
  },
};

const authHandler = NextAuth(authOptions);

// Detect real host from proxy headers and set NEXTAUTH_URL per-request
function applyHost(req: NextRequest) {
  const proto = req.headers.get('x-forwarded-proto') || 'http';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000';
  process.env.NEXTAUTH_URL = `${proto}://${host}`;
}

export async function GET(req: NextRequest, ctx: any) {
  applyHost(req);
  return authHandler(req, ctx);
}

export async function POST(req: NextRequest, ctx: any) {
  applyHost(req);
  return authHandler(req, ctx);
}
