import { renderMinimalViewportHtml } from '@/lib/viewportReproduction/html';

export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(renderMinimalViewportHtml(process.env.NEXT_PUBLIC_VIEWPORT_DIAGNOSTICS_REVISION ?? null), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
