import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/chatStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function readRevision(): string | null {
  try {
    return readFileSync(path.join(process.cwd(), 'REVISION'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    getDb().prepare('SELECT 1').get();
    return NextResponse.json({ ok: true, version: readRevision() });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
