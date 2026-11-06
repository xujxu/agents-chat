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
  if (role !== 'admin' && !isInsideUsableWorkspace(token, resolved)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  const body = fs.readFileSync(resolved);
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-Content-Type-Options': 'nosniff',
  };
  // Agent-generated pages run scripts, so keep them in an opaque origin away from the app's cookies and APIs.
  if (ACTIVE_CONTENT.has(ext)) headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-popups allow-forms';
  return new NextResponse(body, { headers });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isInsideUsableWorkspace(token: any, filePath: string): boolean {
  let realFile: string;
  try { realFile = fs.realpathSync.native(filePath); } catch { return false; }
  return usableAgents(token).some((agent) => {
    if (agent.relay || !agent.cwd) return false;
    let root: string;
    try { root = fs.realpathSync.native(agent.cwd); } catch { return false; }
    const relative = path.relative(root, realFile);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}
