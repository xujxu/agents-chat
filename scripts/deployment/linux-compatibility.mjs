import { inspectLinuxConfiguration } from './linux-configuration.mjs';
import { inspectLinuxData } from './linux-data.mjs';
import { inspectLinuxNodeVersion } from './linux-node-version.mjs';
import { inspectTargetCompatibility } from './target-compatibility.mjs';

export async function admitLinuxCompatibility({ service, operation, commit, signal }) {
  signal?.throwIfAborted();
  await service.check();
  const runtime = await inspectLinuxNodeVersion({ service, operation, signal });
  const target = await inspectTargetCompatibility({
    project: service.identity.runtime.project, commit,
    nodeVersion: runtime.nodeVersion, platform: runtime.platform, signal,
  });
  const configuration = await inspectLinuxConfiguration({
    service, profile: target.configurationProfile, signal,
  });
  const inspectData = () => inspectLinuxData({
    service, operation, profile: target.databaseProfile, signal,
  });
  const data = await inspectData();
  await configuration.check();
  const check = async () => {
    signal?.throwIfAborted();
    await configuration.check();
    await inspectData();
    await configuration.check();
  };
  // Historical mode is limited by the target reader to the exact reviewed commit
  // and source bindings. It uses this controller, never that target's deploy code.
  return Object.freeze({
    compatibility: 'passed', commit: target.commit, mode: target.mode,
    adapter: target.mode === 'historical' ? 'agents-chat-638c553' : 'protocol-1',
    runtime, configuration: Object.freeze({
      status: configuration.status, profile: configuration.profile, providers: configuration.providers,
    }), data, pendingChecks: Object.freeze([]), check,
  });
}
