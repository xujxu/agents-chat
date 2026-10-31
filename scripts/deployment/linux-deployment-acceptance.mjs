import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { lstat } from 'node:fs/promises';
import { fileDigest } from './snapshot-files.mjs';
import { validateGitMetadata } from './git-metadata.mjs';
import { waitLinuxReadiness } from './linux-readiness.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function captureLinuxDeploymentAcceptance({
  service, configuration, source, artifacts, port, waitSeconds = 120, signal,
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'linux' || [service?.check, configuration?.check, source?.check, artifacts?.check]
    .some(check => typeof check !== 'function')) throw new Error('Linux acceptance requires retained source, artifact and runtime authority.');
  const record = validateGitMetadata(source.record, source.record?.commit);
  const artifactIdentity = { ...artifacts.identity };
  if (artifactIdentity.version !== 1 || ['build', 'dependencies', 'package', 'lock']
    .some(key => !/^[a-f0-9]{64}$/.test(artifactIdentity[key] ?? ''))) {
    throw new Error('Linux acceptance requires complete artifact identities.');
  }
  const runtimeIdentity = digest(service.identity);
  const observe = async checkSignal => {
    checkSignal?.throwIfAborted();
    await service.check();
    await configuration.check({ signal: checkSignal });
    await source.check({ signal: checkSignal });
    if (!same(source.record, record) || !same(artifacts.identity, artifactIdentity)
      || digest(service.identity) !== runtimeIdentity) throw new Error('Linux acceptance authority changed.');
    await artifacts.check({ signal: checkSignal });
    const files = [];
    for (const file of configuration.files) {
      checkSignal?.throwIfAborted();
      if (!file.present) { files.push({ path: file.path, present: false }); continue; }
      const info = await lstat(file.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Acceptance configuration file type changed.');
      files.push({ path: file.path, present: true, mode: info.mode & 0o777, uid: info.uid, gid: info.gid,
        sha256: await fileDigest(file.path, { signal: checkSignal }) });
    }
    await waitLinuxReadiness({ service, port, providers: configuration.providers, waitSeconds, signal: checkSignal });
    await configuration.check({ signal: checkSignal });
    await source.check({ signal: checkSignal });
    await artifacts.check({ signal: checkSignal });
    await service.check();
    return Object.freeze({
      source: record.commit, build: artifactIdentity.build, dependencies: artifactIdentity.dependencies,
      config: digest({ profile: configuration.profile, providers: configuration.providers,
        files: files.sort((a, b) => a.path.localeCompare(b.path)), runtime: runtimeIdentity }),
      service: runtimeIdentity,
    });
  };
  const identity = await observe(signal);
  return Object.freeze({
    identity,
    async checkAccepted({ signal: checkSignal } = {}) {
      const current = await observe(checkSignal);
      if (!same(current, identity)) throw new Error('Accepted Linux deployment identity changed.');
      return current;
    },
  });
}
