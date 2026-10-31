import path from 'node:path';
import { assertWindowsColdRestoreLease } from './windows-cold-restore-lease.mjs';
import { inspectWindowsSnapshotRuntime } from './windows-snapshot-runtime.mjs';
import { publishWindowsRuntimeBundle } from './windows-runtime-publication.mjs';

export async function prepareWindowsColdRestoreRuntimeBundle({ control, lease, signal }) {
  await assertWindowsColdRestoreLease(control, lease, { signal });
  const archived = await inspectWindowsSnapshotRuntime({
    project: lease.lock.project, backup: lease.backup, snapshot: lease.snapshot,
    taskName: lease.snapshot.runtime.task.name, signal,
  });
  const configuration = archived.files.find(file => file.name === 'configuration.json');
  return publishWindowsRuntimeBundle({
    directory: path.join(control, `runtime-${lease.owner.operationId}`),
    sourceConfiguration: configuration.file, sha256: archived.task.configurationSha256,
    archiveFiles: archived.files, pwsh: lease.pwsh, signal,
    async check() {
      await lease.checkStopped({ signal });
      await archived.check({ signal });
      await lease.checkStopped({ signal });
    },
  });
}
