import { request } from 'node:http';
import { isDeepStrictEqual as same } from 'node:util';
import { retainLinuxListener } from './linux-listener.mjs';

function readProviders(port, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let failure;
    let bytes;
    const req = request({
      host: '127.0.0.1', port, path: '/api/auth/providers', method: 'GET', agent: false,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', Connection: 'close' },
      maxHeaderSize: 8192,
    }, response => {
      const fail = message => {
        failure ??= new Error(message);
        response.destroy();
        req.destroy(failure);
      };
      if (response.statusCode !== 200
        || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')
        || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        fail('Readiness response must be uncompressed HTTP 200 JSON without redirects.');
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) fail('Readiness response exceeds body size limit.');
        else chunks.push(chunk);
      });
      response.once('end', () => { if (!failure) bytes = Buffer.concat(chunks); });
      response.once('error', () => { failure ??= new Error('Readiness response was interrupted.'); });
    });
    const abort = () => { failure = signal.reason; req.destroy(failure); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      failure ??= new Error('Readiness HTTP request exceeded its deadline.');
      req.destroy(failure);
    }, 3000);
    req.once('error', () => { failure ??= new Error('Readiness HTTP transport failed.'); });
    req.once('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure || !bytes) reject(failure ?? new Error('Readiness response did not complete.'));
      else resolve(bytes);
    });
    if (signal?.aborted) abort();
    else req.end();
  });
}

export async function verifyLinuxReadiness({ service, port, providers, signal }) {
  signal?.throwIfAborted();
  if (!Array.isArray(providers) || !providers.length || new Set(providers).size !== providers.length
    || providers.some(id => !['credentials', 'azure-ad', 'github'].includes(id))) {
    throw new Error('Readiness requires the admitted authentication provider list.');
  }
  const owned = await retainLinuxListener({ service, port, signal });
  const bytes = await readProviders(port, signal);
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Readiness response is not valid UTF-8 provider JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !same(Object.keys(body).sort(), [...providers].sort())
    || providers.some(id => body[id]?.id !== id || typeof body[id].name !== 'string' || !body[id].name
      || body[id].type !== (id === 'credentials' ? 'credentials' : 'oauth')
      || ['signinUrl', 'callbackUrl'].some(key => {
        try {
          const url = new URL(body[id][key]);
          return !['http:', 'https:'].includes(url.protocol) || Boolean(url.username || url.password);
        } catch { return true; }
      }))) {
    throw new Error('Readiness authentication providers do not match admitted configuration.');
  }
  await owned.check();
  return Object.freeze({
    status: 'ready', invocationId: service.identity.runtime.invocationId, port,
    providers: Object.freeze([...providers]),
  });
}
