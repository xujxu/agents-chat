import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { validateGitMetadata } from './git-metadata.mjs';
import { assertWindowsManagedTaskScope } from './windows-managed-task.mjs';
import { waitWindowsReadiness } from './windows-readiness.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const windowsServiceIdentityRecord = observed => ({
  project: observed.project, taskName: observed.taskName, definition: observed.definition,
  securityDescriptor: observed.securityDescriptor, principalSid: observed.principalSid,
  enabled: observed.enabled, configurationSha256: observed.configurationSha256,
});
const serviceIdentity = observed => digest(windowsServiceIdentityRecord(observed));
export const windowsConfigurationIdentity = configuration => digest({
  profile: configuration.profile, providers: configuration.providers,
  projectSecurityDescriptor: configuration.projectSecurityDescriptor,
  files: configuration.files.map(({ path, present, sha256, securityDescriptor }) =>
    ({ path, present, sha256, securityDescriptor })).sort((a, b) => a.path.localeCompare(b.path)),
});

export async function captureWindowsDeploymentAcceptance({
  scope, configuration, source, artifacts, port, waitSeconds = 120, signal,
}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32'
    || [configuration?.checkFiles, source?.check, artifacts?.check].some(check => typeof check !== 'function')) {
    throw new Error('Windows acceptance requires retained configuration, source, artifact and managed runtime authority.');
  }
  const original = await assertWindowsManagedTaskScope(scope, { signal });
  const record = validateGitMetadata(source.record, source.record?.commit);
  const artifactIdentity = { ...artifacts.identity };
  if (artifactIdentity.version !== 1 || ['build', 'dependencies', 'package', 'lock']
    .some(key => !/^[a-f0-9]{64}$/.test(artifactIdentity[key] ?? ''))) {
    throw new Error('Windows acceptance requires complete artifact identities.');
  }
  const service = serviceIdentity(original);
  const config = windowsConfigurationIdentity(configuration);
  const check = async checkSignal => {
    checkSignal?.throwIfAborted();
    const observed = await assertWindowsManagedTaskScope(scope, { signal: checkSignal });
    await configuration.checkFiles({ signal: checkSignal });
    await source.check({ signal: checkSignal });
    await artifacts.check({ signal: checkSignal });
    if (!same(observed, original) || !same(source.record, record) || !same(artifacts.identity, artifactIdentity)
      || serviceIdentity(observed) !== service || windowsConfigurationIdentity(configuration) !== config) {
      throw new Error('Accepted Windows deployment authority changed.');
    }
  };
  const observe = async checkSignal => {
    await check(checkSignal);
    await waitWindowsReadiness({ context: scope, port, providers: configuration.providers,
      waitSeconds, signal: checkSignal });
    await check(checkSignal);
    return Object.freeze({
      source: record.commit, build: artifactIdentity.build, dependencies: artifactIdentity.dependencies, config, service,
    });
  };
  const identity = await observe(signal);
  return Object.freeze({
    identity,
    async checkAccepted({ signal: checkSignal } = {}) {
      return observe(checkSignal);
    },
  });
}
