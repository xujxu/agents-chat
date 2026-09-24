import { atomicWrite, decodeEnvironment, encodeEnvironment, optionalRead } from '../configuration-files.mjs';

try {
  const [file, url, extra] = process.argv.slice(2);
  if (!file || !url || extra || /[\x00-\x20\x7f$"'`]/.test(url) || !['http:', 'https:'].includes(new URL(url).protocol)) {
    throw new Error('Expected environment file and an http(s) URL without control or expansion characters.');
  }
  const original = await optionalRead(file);
  if (original === null) throw new Error('Environment file is missing.');
  const text = decodeEnvironment(original);
  const lines = text.split(/\r?\n/);
  const key = /^\s*#?\s*NEXTAUTH_URL\s*=/;
  const matches = lines.filter(line => key.test(line));
  if (matches.length !== 1 || matches[0].trim() !== `NEXTAUTH_URL=${url}`) {
    const next = lines.filter(line => !key.test(line));
    while (next.at(-1) === '') next.pop();
    next.push(`NEXTAUTH_URL=${url}`, '');
    await atomicWrite(file, encodeEnvironment(next.join('\n')), original);
  }
} catch (error) {
  console.error(`Environment URL update failed: ${error.message}`);
  process.exitCode = 1;
}
