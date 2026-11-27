import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Files API lists binary files but refuses to preview or overwrite them', async (t) => {
  const originalCwd = process.cwd();
  const originalEnv = { ADMIN_EMAILS: process.env.ADMIN_EMAILS, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET };
  const dir = mkdtempSync(path.join(tmpdir(), 'agents-chat-binary-files-'));
  const workspace = path.join(dir, 'workspace');
  process.chdir(dir);
  t.after(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite may still hold the file on Windows */ }
  });
  process.env.ADMIN_EMAILS = 'admin@contoso.com';
  process.env.NEXTAUTH_SECRET = 'binary-files-test-secret';

  // A folder holding only Word documents must still appear in the tree.
  mkdirSync(path.join(workspace, 'ref'), { recursive: true });
  const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x10]);
  writeFileSync(path.join(workspace, 'ref', 'spec.docx'), docx);
  writeFileSync(path.join(workspace, 'notes.md'), '# Notes\n');

  const configStore = await import('../lib/configStore');
  const { encode } = await import('next-auth/jwt');
  const { NextRequest } = await import('next/server');
  const route = await import('../app/api/markdown/route');
  configStore.createAgent({ id: 'files', name: 'Files', owner: 'admin@contoso.com', cwd: workspace });

  const call = async (query: string, body?: Record<string, unknown>) => {
    const cookie = await encode({ token: { email: 'admin@contoso.com', sub: 'admin@contoso.com', provider: 'azure-ad' }, secret: process.env.NEXTAUTH_SECRET! });
    const req = new NextRequest(`http://localhost/api/markdown${query}`, {
      method: body ? 'POST' : 'GET',
      headers: { cookie: `next-auth.session-token=${cookie}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = body ? await route.POST(req) : await route.GET(req);
    return { status: res.status, data: await res.json() };
  };

  const list = await call('?agentId=files');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.files.map((file: { path: string }) => file.path), ['notes.md', 'ref/spec.docx']);

  const preview = await call('?agentId=files&path=ref%2Fspec.docx');
  assert.equal(preview.status, 415);
  assert.match(preview.data.error, /Preview isn't available for \.docx files/);

  const save = await call('', { agentId: 'files', path: 'ref/spec.docx', content: 'text' });
  assert.equal(save.status, 415);
  assert.deepEqual(readFileSync(path.join(workspace, 'ref', 'spec.docx')), docx, 'the binary file is untouched');

  const text = await call('?agentId=files&path=notes.md');
  assert.equal(text.status, 200);
  assert.equal(text.data.content, '# Notes\n');
});
