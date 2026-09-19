import type { NextRequest } from 'next/server';
import { getAuthToken, isAdminToken } from './auth';
import { DiagnosticError } from './viewportDiagnosticStore';

export async function requireViewportDiagnosticUpload(request: NextRequest): Promise<void> {
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
}
