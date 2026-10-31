import { createReadStream } from 'node:fs';
import { readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { processIdentity } from './process-identity.mjs';

async function boundedText(file, maximum, signal) {
  signal?.throwIfAborted();
  const stream = createReadStream(file, { signal });
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maximum) throw new Error('Listener ownership observation exceeds its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function listener(port, signal) {
  const matches = [];
  for (const table of ['tcp', 'tcp6']) {
    const text = await boundedText(`/proc/self/net/${table}`, 4 * 1024 * 1024, signal);
    for (const line of text.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '0A') continue;
      const [address, encodedPort] = fields[1].split(':');
      if (parseInt(encodedPort, 16) !== port) continue;
      const allowed = table === 'tcp' ? ['00000000', '0100007F']
        : ['00000000000000000000000000000000', '0000000000000000FFFF00000100007F'];
      if (!allowed.includes(address) || !/^[1-9][0-9]*$/.test(fields[9] ?? '')) {
        throw new Error('Readiness listener is not an unambiguous IPv4 loopback-accessible socket.');
      }
      matches.push(fields[9]);
    }
  }
  if (!matches.length) throw Object.assign(new Error('Readiness listener is not yet available.'), {
    code: 'DEPLOYMENT_READINESS_NOT_READY',
  });
  if (matches.length !== 1) throw new Error('Readiness requires exactly one owned listener on the selected port.');
  return matches[0];
}

export async function retainLinuxListener({ service, port, signal }) {
  if (process.platform !== 'linux' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Linux listener readiness requires a valid explicit port.');
  }
  await service.check();
  const { runtime, controlGroup } = service.identity;
  if (controlGroup !== `/system.slice/${runtime.unit}`) throw new Error('Unsupported service listener cgroup.');
  const network = await readlink('/proc/self/ns/net');
  if (await readlink(`/proc/${runtime.mainPid}/ns/net`) !== network) {
    throw new Error('Readiness cannot inspect a service in another network namespace.');
  }
  const inode = await listener(port, signal);
  const pids = (await boundedText(path.join('/sys/fs/cgroup', controlGroup, 'cgroup.procs'), 65536, signal))
    .trim().split(/\s+/);
  if (pids.length > 4096 || pids.some(pid => !/^[1-9][0-9]*$/.test(pid))) {
    throw new Error('Invalid service listener process inventory.');
  }
  let retained;
  for (const text of pids) {
    signal?.throwIfAborted();
    const pid = Number(text);
    const identity = await processIdentity(pid);
    if (!identity) throw new Error('Service process changed during listener inspection.');
    const files = await readdir(`/proc/${pid}/fd`);
    if (files.length > 8192) throw new Error('Service listener descriptor inventory exceeds limit.');
    for (const fd of files) {
      let target;
      try { target = await readlink(`/proc/${pid}/fd/${fd}`); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (target === `socket:[${inode}]`) {
        retained = { pid, identity, fd };
        break;
      }
    }
    if (retained) break;
  }
  if (!retained) throw new Error('Readiness listener is not owned by the managed service.');
  const check = async () => {
    signal?.throwIfAborted();
    await service.check();
    if (await processIdentity(retained.pid) !== retained.identity
      || (await boundedText(`/proc/${retained.pid}/cgroup`, 65536, signal)).trim() !== `0::${controlGroup}`
      || await readlink(`/proc/${retained.pid}/ns/net`) !== network
      || await readlink(`/proc/${retained.pid}/fd/${retained.fd}`) !== `socket:[${inode}]`
      || await listener(port, signal) !== inode) {
      throw new Error('Retained service listener identity changed during readiness.');
    }
    signal?.throwIfAborted();
  };
  await check();
  return Object.freeze({ check });
}
