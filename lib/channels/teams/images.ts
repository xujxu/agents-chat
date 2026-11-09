import { randomUUID } from 'node:crypto';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from '@/lib/acp/attachments';
import type { StoredAttachment } from '@/lib/chatStore';
import { createLogger } from '@/lib/logger';
import { getBotAccessToken } from './auth';
import type { TeamsConfig } from './config';
import { isAllowedServiceUrl } from './util';

const logger = createLogger('teams-bot');

const DOWNLOAD_TIMEOUT_MS = 30_000;
const FILE_DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info';
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

export type TeamsAttachment = { contentType?: string; contentUrl?: string; name?: string; content?: unknown };

/** An image in a Teams message, and whether downloading it needs the bot token. */
export type TeamsImageRef = { url: string; name: string; botAuth: boolean };

/** Hosts Teams serves pasted images from; they require the bot token. */
function isTeamsImageHost(url: URL): boolean {
  return isAllowedServiceUrl(url.href) || (url.protocol === 'https:' && url.hostname.toLowerCase().endsWith('.asm.skype.com'));
}

/** Pre-authenticated OneDrive/SharePoint links for files sent in a 1:1 chat; no token is sent. */
function isFileDownloadHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && (host.endsWith('.sharepoint.com') || host.endsWith('.sharepoint-df.com'));
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try { return new URL(value); } catch { return null; }
}

/**
 * Images attached to a Teams message: pasted or inline images (`image/*` with a `contentUrl` on a
 * Teams host) and image files sent in a 1:1 chat (`file.download.info` with a SharePoint link).
 * URLs on any other host are ignored so the bot token never leaves Microsoft's Teams services.
 */
export function teamsImageRefs(attachments: TeamsAttachment[] | undefined): TeamsImageRef[] {
  const refs: TeamsImageRef[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments ?? []) {
    const type = attachment.contentType?.toLowerCase() ?? '';
    let ref: TeamsImageRef | null = null;
    if (type.startsWith('image/')) {
      const url = parseUrl(attachment.contentUrl);
      if (url && isTeamsImageHost(url)) ref = { url: url.href, name: attachment.name || '', botAuth: true };
    } else if (type === FILE_DOWNLOAD_INFO && IMAGE_EXTENSIONS.test(attachment.name ?? '')) {
      const url = parseUrl((attachment.content as { downloadUrl?: unknown } | undefined)?.downloadUrl);
      if (url && isFileDownloadHost(url)) ref = { url: url.href, name: attachment.name || '', botAuth: false };
    }
    if (!ref || seen.has(ref.url)) continue;
    seen.add(ref.url);
    refs.push(ref);
  }
  return refs.slice(0, MAX_ATTACHMENTS);
}

/** Whether the message has attachments other than Teams' HTML copy of the text. */
export function hasNonTextAttachments(attachments: TeamsAttachment[] | undefined): boolean {
  return !!attachments?.some((a) => a.contentType && a.contentType !== 'text/html');
}

function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const EXTENSION_BY_TYPE: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

async function readLimited(res: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function downloadImage(config: TeamsConfig, ref: TeamsImageRef, index: number, limit: number): Promise<StoredAttachment | null> {
  const headers: Record<string, string> = {};
  if (ref.botAuth) headers.Authorization = `Bearer ${await getBotAccessToken(config)}`;
  const res = await fetch(ref.url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = await readLimited(res, limit);
  if (!bytes) throw new Error('too_large');
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw new Error('not_an_image');
  const name = ref.name && IMAGE_EXTENSIONS.test(ref.name) ? ref.name : `image-${index + 1}.${EXTENSION_BY_TYPE[mimeType]}`;
  return { id: `teams-image-${randomUUID()}`, name, mimeType, size: bytes.length, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, kind: 'image' };
}

/** Download the images; failures are logged and skipped so the text still reaches the agent. */
export async function downloadTeamsImages(config: TeamsConfig, refs: TeamsImageRef[]): Promise<StoredAttachment[]> {
  const images: StoredAttachment[] = [];
  let total = 0;
  for (const [index, ref] of refs.entries()) {
    try {
      const image = await downloadImage(config, ref, index, Math.min(MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES - total));
      if (!image) continue;
      total += image.size;
      images.push(image);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), host: new URL(ref.url).hostname }, 'Could not download Teams image');
    }
  }
  return images;
}
