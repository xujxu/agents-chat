import { NextRequest, NextResponse } from 'next/server';
import { getAuthToken, isAdminToken } from '@/lib/auth';
import { createLogger } from '@/lib/logger';
import { validateDiagnosticLog } from '@/lib/viewportDiagnostics';
import { DiagnosticError, readDiagnosticBody, storeViewportDiagnostic } from '@/lib/viewportDiagnosticStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const logger = createLogger('viewport-diagnostics');

export async function POST(request: NextRequest) {
  try {
    const token = await getAuthToken(request);
    if (!token) throw new DiagnosticError(401, 'unauthenticated', 'Sign in before uploading diagnostics.');
    if (!isAdminToken(token)) throw new DiagnosticError(403, 'admin_only', 'Only administrators can upload diagnostics.');
    const expectedOrigin = new URL(process.env.NEXTAUTH_URL || request.url).origin;
    if (request.headers.get('origin') !== expectedOrigin) {
      throw new DiagnosticError(403, 'origin_denied', 'Diagnostic uploads must come from this site.');
    }
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new DiagnosticError(415, 'content_type', 'Diagnostic uploads require JSON.');
    }
    const log = await readDiagnosticBody(request);
    if (typeof log === 'object' && log !== null && 'version' in log
      && (log.version === 1 || log.version === 2 || log.version === 3 || log.version === 4)) {
      throw new DiagnosticError(400, 'outdated_log', 'Open a fresh diagnostic tab and collect a new log before uploading.');
    }
    if (!validateDiagnosticLog(log)) throw new DiagnosticError(400, 'invalid_log', 'Diagnostic log does not match the permitted schema.');
    const id = await storeViewportDiagnostic(log);
    return NextResponse.json({ ok: true, id }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof DiagnosticError) {
      logger.warn({ code: error.code, status: error.status }, 'Diagnostic upload rejected');
      return NextResponse.json({ ok: false, error: error.code, message: error.message }, {
        status: error.status, headers: { 'Cache-Control': 'no-store' },
      });
    }
    logger.error({ err: error }, 'Diagnostic log could not be saved');
    return NextResponse.json({ ok: false, error: 'storage_error', message: 'Diagnostic log could not be saved. Please retry.' }, {
      status: 500, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
