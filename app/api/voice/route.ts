import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getAuthToken } from '@/lib/auth';
import { createLogger } from '@/lib/logger';
import { MAX_VOICE_BYTES, MAX_VOICE_SECONDS, validateVoiceWav, VoiceError } from '@/lib/voice/audio';
import { cancelVoiceJob, reserveVoiceJob } from '@/lib/voice/jobs';
import { transcribeVoice, voiceConfiguration } from '@/lib/voice/transcriber';
import { assertVoiceMemoryAvailable } from '@/lib/voice/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const logger = createLogger('api.voice');
const headers = { 'Cache-Control': 'no-store' };
const json = (body: object, status = 200) => NextResponse.json(body, { status, headers });

function errorResponse(error: unknown) {
  const known = error instanceof VoiceError;
  const code = known ? error.code : 'voice_failed';
  // Never log a request body, transcript, child output, or filesystem error message.
  logger.warn({ code }, 'Voice request failed');
  return json({ ok: false, error: code }, known ? error.status : 500);
}

function requestId(req: NextRequest) {
  const id = req.headers.get('x-voice-request-id') || randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new VoiceError('voice_invalid_request', 400);
  }
  return id;
}

function checkOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  const expected = process.env.NEXTAUTH_URL ? new URL(process.env.NEXTAUTH_URL).origin : req.nextUrl.origin;
  if (origin && origin !== expected) throw new VoiceError('voice_forbidden', 403);
  if (req.headers.get('sec-fetch-site') === 'cross-site') throw new VoiceError('voice_forbidden', 403);
}

async function readAudio(req: NextRequest, signal: AbortSignal) {
  const declared = req.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_VOICE_BYTES)) {
    throw new VoiceError('voice_too_large', 413);
  }
  const reader = req.body?.getReader();
  if (!reader) throw new VoiceError('voice_no_audio', 422);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => logger.warn('Voice upload cancellation failed')); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > MAX_VOICE_BYTES) {
        await reader.cancel();
        throw new VoiceError('voice_too_large', 413);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export async function GET(req: NextRequest) {
  if (!await getAuthToken(req)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const configuration = await voiceConfiguration();
    return json({ ok: true, enabled: !!configuration, maxSeconds: MAX_VOICE_SECONDS, model: 'base-q5_1' });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token) return json({ ok: false, error: 'unauthorized' }, 401);
  let job: ReturnType<typeof reserveVoiceJob> | undefined;
  try {
    checkOrigin(req);
    const userId = String(token.email || token.name || token.sub || '');
    if (!userId || req.headers.get('x-voice-user-id') !== userId) throw new VoiceError('voice_account_changed', 403);
    const configuration = await voiceConfiguration();
    if (!configuration) throw new VoiceError('voice_disabled', 503);
    if (req.headers.get('content-type')?.split(';')[0].trim() !== 'audio/wav') throw new VoiceError('voice_unsupported_format', 415);
    job = reserveVoiceJob(userId, requestId(req), req.signal);
    const bytes = await readAudio(req, job.signal);
    const { durationSeconds } = validateVoiceWav(bytes);
    await assertVoiceMemoryAvailable();
    const started = performance.now();
    const text = await transcribeVoice(bytes, configuration, job.signal);
    const elapsedMs = Math.round(performance.now() - started);
    logger.info({ durationSeconds, elapsedMs, bytes: bytes.length }, 'Voice transcription completed');
    return json({ ok: true, text, elapsedMs });
  } catch (error) { return errorResponse(job?.signal.aborted ? job.signal.reason : error); }
  finally { job?.release(); }
}

export async function DELETE(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    checkOrigin(req);
    const userId = String(token.email || token.name || token.sub || '');
    if (!userId || req.headers.get('x-voice-user-id') !== userId) throw new VoiceError('voice_account_changed', 403);
    cancelVoiceJob(userId, requestId(req));
    return json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
