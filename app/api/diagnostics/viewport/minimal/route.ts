import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { requireViewportDiagnosticUpload } from '@/lib/viewportDiagnosticAdmission';
import { DiagnosticError, readDiagnosticBody, storeViewportDiagnostic } from '@/lib/viewportDiagnosticStore';
import { validateMinimalViewportLog } from '@/lib/viewportReproduction/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const logger = createLogger('minimal-viewport-diagnostics');

export async function POST(request: NextRequest) {
  try {
    await requireViewportDiagnosticUpload(request);
    const log = await readDiagnosticBody(request);
    if (!validateMinimalViewportLog(log)) {
      throw new DiagnosticError(400, 'invalid_log', 'Minimal diagnostic log does not match the permitted schema.');
    }
    const id = await storeViewportDiagnostic(log);
    return NextResponse.json({ ok: true, id }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof DiagnosticError) {
      logger.warn({ code: error.code, status: error.status }, 'Minimal diagnostic upload rejected');
      return NextResponse.json({ ok: false, error: error.code, message: error.message }, {
        status: error.status, headers: { 'Cache-Control': 'no-store' },
      });
    }
    logger.error({ err: error }, 'Minimal diagnostic log could not be saved');
    return NextResponse.json({ ok: false, error: 'storage_error', message: 'Diagnostic log could not be saved. Please retry.' }, {
      status: 500, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
