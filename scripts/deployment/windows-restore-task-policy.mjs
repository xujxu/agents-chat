import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity } from './process-identity.mjs';
import { captureWorkerFields } from './worker-identity.mjs';
import { assertWindowsManagedTaskScope } from './windows-managed-task.mjs';
import { windowsControllerTransport } from './windows-controller-transport.mjs';

const script = fileURLToPath(new URL('./windows-restore-task-policy.ps1', import.meta.url));
function refused(cause) {
  return Object.assign(new Error('Saved Windows task policy comparison refused; retain the current task and backup.', { cause }), {
    code: 'DEPLOYMENT_WINDOWS_RESTORE_POLICY_REFUSED', runtimeAuthority: false,
  });
}

export async function inspectWindowsRestoreTaskPolicy({ scope, task: supplied, pwsh, signal }) {
  signal?.throwIfAborted();
  let bridge;
  try {
    if (process.platform !== 'win32' || typeof pwsh !== 'string' || !path.isAbsolute(pwsh)
      || path.resolve(pwsh) !== pwsh || /[\0\r\n]/.test(pwsh)) {
      throw new Error('Restore policy inspection requires explicit canonical Windows PowerShell.');
    }
    const original = await assertWindowsManagedTaskScope(scope, { signal });
    const task = captureWorkerFields(supplied,
      ['version', 'name', 'definition', 'securityDescriptor', 'configuration', 'configurationSha256'], 'saved restore task');
    if (task.version !== 1 || task.name !== original.taskName
      || task.securityDescriptor !== original.securityDescriptor
      || typeof task.definition !== 'string' || !task.definition || task.definition.length > 262144
      || task.definition.includes('\0')) {
      throw new Error('Saved task identity, security or definition differs from the original observation.');
    }
    const controllerIdentity = await processIdentity(process.pid);
    if (!controllerIdentity) throw new Error('Original restore policy observer identity is unavailable.');
    signal?.throwIfAborted();
    bridge = windowsControllerTransport({
      pwsh, refused, label: 'Native restore policy observer',
      args: ['-NoProfile', '-NonInteractive', '-File', script,
        '-ControllerPid', String(process.pid), '-ControllerIdentity', controllerIdentity],
    });
    for (const [index, policy] of [original, task].entries()) {
      await bridge.wire.send({ id: index + 1, method: 'policy',
        definition: policy.definition, securityDescriptor: policy.securityDescriptor });
    }
    const ready = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 60000 }),
      ['type', 'pid', 'processIdentity', 'controllerIdentity', 'value'], 'restore policy readiness');
    if (ready.type !== 'ready' || ready.pid !== bridge.child.pid || ready.controllerIdentity !== controllerIdentity
      || ready.processIdentity !== await processIdentity(bridge.child.pid) || ready.value !== 'same-task-policy') {
      throw new Error('Original native restore policy observation differs.');
    }
    await assertWindowsManagedTaskScope(scope, { signal });
    await bridge.wire.send({ id: 3, method: 'close' });
    const reply = captureWorkerFields(await bridge.wire.receive({ signal, timeoutMs: 30000 }),
      ['id', 'type', 'value', 'processIdentity'], 'restore policy close');
    if (reply.id !== 3 || reply.type !== 'reply' || reply.value !== 'close' || reply.processIdentity !== ready.processIdentity) {
      throw new Error('Unexpected restore policy close acknowledgement.');
    }
    const result = await bridge.waitForExit();
    if (result.code !== 0 || result.signal !== null) throw new Error('Native restore policy observer did not close cleanly.');
    bridge.wire.close();
    await assertWindowsManagedTaskScope(scope, { signal });
    return Object.freeze({ status: 'same-task-policy', runtimeAuthority: false, taskName: original.taskName });
  } catch (cause) {
    if (!bridge) throw refused(cause);
    throw await bridge.abandon(cause);
  }
}
