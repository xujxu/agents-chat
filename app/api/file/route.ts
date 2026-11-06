import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getAuthToken } from '@/lib/auth';
import { getUserRole, usableAgents } from '@/lib/rbac';

const ACTIVE_CONTENT = new Set(['.html', '.htm', '.svg']);

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export async function GET(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const role = getUserRole(token);
  if (!role) return NextResponse.json({ error: 'not_authorized' }, { status: 403 });

  const filePath = req.nextUrl.searchParams.get('path');
  if (!filePath) {
    return NextResponse.json({ error: 'missing path param' }, { status: 400 });
  }

  const resolved = path.resolve(filePath);

  // Block obvious sensitive paths
  const blocked = ['/etc/shadow', '/etc/passwd', 'id_rsa', '.env'];
  if (blocked.some(b => resolved.toLowerCase().includes(b))) {
    return NextResponse.json({ error: 'blocked path' }, { status: 403 });
  }

  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: 'file not found' }, { status: 404 });
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return NextResponse.json({ error: 'not a file' }, { status: 400 });
  }

  // Non-admins may only read files inside the workspace of a local agent they can use.
  let readPath = resolved;
  if (role !== 'admin') {
    const realFile = usableWorkspaceFile(token, resolved);
    if (!realFile) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    readPath = realFile;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  const body = role === 'admin' ? fs.readFileSync(readPath) : readCheckedFile(readPath);
  if (!body) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-Content-Type-Options': 'nosniff',
  };
  // Agent-generated pages run scripts, so keep them in an opaque origin away from the app's cookies and APIs.
  if (ACTIVE_CONTENT.has(ext)) headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-popups allow-forms';
  return new NextResponse(body, { headers });
}

/** The real path of `filePath` when it lies inside the workspace of a local agent this user can use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function usableWorkspaceFile(token: any, filePath: string): string | null {
  let realFile: string;
  try { realFile = fs.realpathSync.native(filePath); } catch { return null; }
  const inside = usableAgents(token).some((agent) => {
    if (agent.relay || !agent.cwd) return false;
    let root: string;
    try { root = fs.realpathSync.native(agent.cwd); } catch { return false; }
    const relative = path.relative(root, realFile);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  return inside ? realFile : null;
}

/**
 * Reads the checked real path, refusing when it was swapped (e.g. a directory replaced by a symlink) between
 * the workspace check and the open: the opened file must still be the one the real path names.
 */
function readCheckedFile(realFile: string): Buffer | null {
  let fd: number;
  try { fd = fs.openSync(realFile, 'r'); } catch { return null; }
  try {
    const opened = fs.fstatSync(fd);
    const current = fs.statSync(realFile);
    if (!opened.isFile() || fs.realpathSync.native(realFile) !== realFile
      || opened.ino !== current.ino || opened.dev !== current.dev) return null;
    return fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
