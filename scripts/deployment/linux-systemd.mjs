import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' };

export const linuxNative = (file, args) => execute(file, args, {
  env, timeout: 30000, maxBuffer: 16384,
});

export async function linuxSystemdProperties(unit, names) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,180}\.service$/.test(unit)
    || !Array.isArray(names) || !names.length || new Set(names).size !== names.length
    || names.some(name => !/^[A-Za-z][A-Za-z0-9]*$/.test(name))) {
    throw new Error('Unsupported systemd unit or property request.');
  }
  const { stdout } = await linuxNative('/usr/bin/systemctl',
    ['--system', 'show', unit, '--all', `--property=${names.join(',')}`]);
  const result = {};
  for (const line of stdout.trimEnd().split('\n')) {
    const end = line.indexOf('=');
    const name = line.slice(0, end);
    if (end < 1 || !names.includes(name) || Object.hasOwn(result, name)) throw new Error('Malformed systemd property response.');
    result[name] = line.slice(end + 1);
  }
  const missing = names.filter(name => !Object.hasOwn(result, name));
  if (missing.length) throw new Error(`Missing required systemd properties: ${missing.join(', ')}.`);
  return Object.freeze(result);
}
