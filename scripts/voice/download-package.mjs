import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileSha256 } from './install-package.mjs';
import { validateArtifact } from './download-catalog.mjs';

export async function ghToFile(args, file, limit, timeout, launch = spawn) {
  const child = launch('gh', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let failure;
  const closed = new Promise(resolve => {
    child.once('error', () => { failure = new Error('Cannot run gh. Install GitHub CLI and authenticate for repository Actions read access.'); });
    child.once('close', code => resolve(code));
  });
  const timer = setTimeout(() => {
    failure = new Error('Experimental voice download timed out.');
    child.kill('SIGKILL');
  }, timeout);
  let bytes = 0;
  const bound = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new Error('Experimental voice download exceeded its byte limit.') : null, chunk);
    },
  });
  try {
    await pipeline(child.stdout, bound, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    failure ??= error;
    child.kill('SIGKILL');
  }
  const code = await closed.finally(() => clearTimeout(timer));
  if (failure) throw failure;
  if (code !== 0) throw new Error('GitHub artifact request failed. Check gh installation/authentication, Actions read access and candidate expiry; no fallback was attempted.');
  return bytes;
}

export async function withDownloadedPackage(entry, consume, {
  transfer = ghToFile, log = console.log, now = Date.now(),
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'agents-chat-voice-download-'));
  try {
    const endpoint = `repos/${entry.repository}/actions/artifacts/${entry.artifact}`;
    const metadataFile = path.join(root, 'metadata.json');
    await transfer(['api', endpoint], metadataFile, 64 * 1024, 60_000);
    let value;
    try { value = JSON.parse(await readFile(metadataFile, 'utf8')); }
    catch { throw new Error('GitHub returned invalid experimental artifact metadata.'); }
    validateArtifact(value, entry, now);
    log(`EXPERIMENTAL candidate (not release approved): ${entry.model}, ${entry.platform}-x64.`);
    log(`${entry.repository} artifact ${entry.artifact}, commit ${entry.commit}; expires ${value.expires_at}.`);
    const archive = path.join(root, 'candidate.zip');
    await transfer(['api', `${endpoint}/zip`], archive, entry.bytes, 300_000);
    if ((await stat(archive)).size !== entry.bytes || await fileSha256(archive) !== entry.archiveSha256) {
      throw new Error('Experimental voice archive size/checksum mismatch.');
    }
    const { extractArchive } = await import('./download-archive.mjs');
    const packageDir = path.join(root, 'package');
    await mkdir(packageDir, { mode: 0o700 });
    await extractArchive(archive, packageDir);
    if (await fileSha256(path.join(packageDir, 'voice-package.json')) !== entry.manifestSha256) {
      throw new Error('Experimental voice manifest checksum mismatch.');
    }
    return await consume({ packageDir, manifestSha256: entry.manifestSha256 });
  } finally { await rm(root, { recursive: true, force: true }); }
}
