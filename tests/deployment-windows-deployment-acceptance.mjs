import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWindowsReadinessEndpoint } from './deployment-windows-readiness-cases.mjs';

async function saved(control, name) {
  const file = path.join(control, 'recovery-engine', name);
  await assert.doesNotReject(access(file), `Missing saved Windows acceptance module: ${name}`);
  return import(pathToFileURL(file).href);
}

async function observe({ control, project, taskName, pwsh }) {
  const { inspectWindowsManagedTask } = await saved(control, 'windows-managed-task.mjs');
  const { inspectWindowsConfiguration } = await saved(control, 'windows-configuration.mjs');
  const scope = await inspectWindowsManagedTask({ project, taskName, pwsh });
  try {
    const configuration = await inspectWindowsConfiguration({ scope, pwsh, profile: 'agents-chat-auth-638c553' });
    return { scope, configuration };
  } catch (error) {
    await scope.close();
    throw error;
  }
}

export async function publishWindowsFixtureAcceptance(options) {
  const { captureWindowsDeploymentAcceptance } = await saved(options.control, 'windows-deployment-acceptance.mjs');
  const { publishDeploymentReceipt, readDeploymentReceipt } = await saved(options.control, 'deployment-receipt.mjs');
  const { scope, configuration } = await observe(options);
  try {
    const { port } = await readWindowsReadinessEndpoint(options.project);
    const input = { scope, configuration, source: options.built.source, artifacts: options.built.artifacts, port };
    await assert.rejects(captureWindowsDeploymentAcceptance({ ...input, scope: { ...scope } }));
    const accepted = await captureWindowsDeploymentAcceptance(input);
    assert.equal(accepted.identity.source, options.built.sourceCommit);
    assert.equal(await readDeploymentReceipt(options.control, options.project), null);
    await options.context.check();
    const receipt = await publishDeploymentReceipt({ control: options.control, lock: options.lock, ...accepted });
    assert.deepEqual(receipt.identity, accepted.identity);
    assert.equal(receipt.operationId, options.lock.operationId);
    assert.deepEqual(await readDeploymentReceipt(options.control, options.project), receipt);
    await options.context.check();
    console.error('PASS: original native completion publishes a checked deployment receipt under its original lock');
  } finally {
    await configuration.close();
    await scope.close();
  }
}

async function verifyCurrent(options) {
  const { inspectCurrentWindowsDeployment } = await saved(options.control, 'windows-current-deployment.mjs');
  const { scope, configuration } = await observe(options);
  const stateFile = path.join(options.control, 'state.json');
  const receiptFile = path.join(options.control, 'deployment.json');
  const stateBytes = await readFile(stateFile);
  const receiptBytes = await readFile(receiptFile);
  try {
    const state = JSON.parse(stateBytes);
    const { port } = await readWindowsReadinessEndpoint(options.project);
    const input = { state, scope, configuration, control: options.control, commit: state.targetCommit, port };
    await assert.rejects(access(path.join(options.control, 'lock')), { code: 'ENOENT' });
    const current = await inspectCurrentWindowsDeployment(input);
    assert.equal(current.current.phase, 'accepted');
    assert.deepEqual(current.current.receipt, JSON.parse(receiptBytes));
    assert.deepEqual(current.current.observed, {
      verified: true, running: true, identity: current.current.receipt.identity,
    });
    await current.check();
    assert.equal(await inspectCurrentWindowsDeployment({ ...input, commit: '0'.repeat(40) }), null);
    const buildFile = path.join(options.project, '.next', 'BUILD_ID');
    const buildBytes = await readFile(buildFile);
    try {
      await writeFile(buildFile, 'changed-build\n');
      await assert.rejects(current.check());
      assert.equal(await inspectCurrentWindowsDeployment(input), null);
    } finally { await writeFile(buildFile, buildBytes); }
    const restored = await inspectCurrentWindowsDeployment(input);
    await restored.check();
    assert.deepEqual(await readFile(stateFile), stateBytes);
    assert.deepEqual(await readFile(receiptFile), receiptBytes);
    await assert.rejects(access(path.join(options.control, 'lock')), { code: 'ENOENT' });
  } finally {
    await configuration.close();
    await scope.close();
  }
  console.log('PASS: saved current-deployment inspection survives native final retirement and rejects artifact drift without claiming no-op');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [control, pwsh, taskName, project] = process.argv.slice(2);
  await verifyCurrent({ control, pwsh, taskName, project });
}
