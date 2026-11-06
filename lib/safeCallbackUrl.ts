/**
 * The path to return to after sign-in (e.g. an invite link) when `raw` points at this site, else '/'.
 * Only a path is returned, so the browser always stays on the current origin. Hosts are compared rather than
 * origins because the middleware assumes https when no proxy header says otherwise.
 */
export function safeCallbackPath(raw: string | null | undefined, currentOrigin: string): string {
  if (!raw) return '/';
  try {
    const base = new URL(currentOrigin);
    const url = new URL(raw, base);
    if (url.host !== base.host || (url.protocol !== 'http:' && url.protocol !== 'https:')) return '/';
    const path = `${url.pathname}${url.search}${url.hash}`;
    // `/.//evil.com` normalizes to the path `//evil.com`, which browsers treat as another site.
    return /^\/[/\\]/.test(path) ? '/' : path;
  } catch {
    return '/';
  }
}
