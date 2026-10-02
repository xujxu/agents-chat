import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, link, mkdir, open, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { createWorkerJournal } from '../scripts/deployment/worker-journal.mjs';
import {
  saveWorkerEngine, verifyWorkerEngine, workerInspectionInvocation,
} from '../scripts/deployment/saved-worker-engine.mjs';

const sourceTree = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));
const files = [
  'linux-worker-bootstrap.mjs', 'linux-worker.mjs', 'owned-worker.mjs', 'process-identity.mjs',
  'saved-worker-engine.mjs', 'saved-worker-inspect.mjs',
  'stage-runner.mjs', 'worker-errors.mjs', 'worker-files.mjs',
  'worker-identity.mjs', 'worker-journal.mjs', 'worker-wire.mjs',
  'WindowsWorkerJob.cs', 'windows-worker-launcher.ps1', 'windows-worker-owner.ps1', 'windows-worker.mjs',
  'WindowsRuntimeDomain.cs', 'WindowsRuntimePipe.cs', 'WindowsRuntimeControl.cs',
  'WindowsPrivateFile.cs', 'WindowsRuntimeLease.cs', 'WindowsRuntimeHost.cs', 'windows-runtime-host.ps1',
  'WindowsPrivateFile.Admission.cs',
  'windows-admission.mjs', 'windows-admission.ps1', 'windows-controller-transport.mjs',
  'windows-runtime-bundle.ps1',
  'WindowsControllerToken.cs', 'WindowsControllerProcess.cs',
  'windows-task-owner-binding.ps1', 'windows-task-maintenance.ps1',
  'windows-task-controller.ps1', 'windows-task-controller.mjs',
  'windows-task-transaction.ps1', 'windows-task-transaction.mjs',
  'windows-task-retirement.ps1', 'windows-task-replacement.ps1', 'windows-task-activation.ps1', 'WindowsRuntimeListener.cs',
  'windows-task-listener.ps1', 'windows-readiness.mjs', 'http-readiness.mjs',
  'windows-task-completion.ps1', 'windows-task-completion.mjs',
  'windows-task-completion-records.ps1', 'windows-task-completion-proof.ps1',
  'windows-task-completion-proof.mjs', 'windows-task-completion-controller.ps1',
  'windows-task-completion-record.mjs', 'windows-task-retirement-record.mjs', 'windows-task-retirement-intent.ps1',
  'windows-task-retirement-checkpoint.mjs', 'windows-task-retirement-checkpoint.ps1',
  'windows-task-retirement-records.ps1', 'windows-task-retirement-scope.ps1', 'windows-task-retirement-scope.mjs',
  'evidence-journal.mjs', 'worker-operation.mjs', 'state.mjs',
  'worker-retirement.mjs',
  'linux-systemd.mjs', 'linux-runtime.mjs',
  'linux-service-inspection.mjs', 'linux-service-sources.mjs',
  'linux-inactive-service.mjs',
  'linux-service-stop.mjs', 'linux-service-stop-evidence.mjs',
  'linux-service-activation.mjs', 'linux-activation-stop.mjs', 'service-activation-workers.mjs',
  'linux-service-retirement.mjs',
  'linux-recovery-admission.mjs',
  'linux-live-retirement.mjs',
  'linux-startup-link.mjs',
  'linux-cold-retirement-proof.mjs', 'linux-cold-activation-state.mjs',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'project with spaces');
  const source = path.join(project, 'scripts', 'deployment');
  const control = path.join(root, '.project.deployment');
  await cp(sourceTree, source, { recursive: true });
  await mkdir(control, { mode: 0o700 });
  const operationId = 'operation-1';
  const owner = { project, operationId, workerId: randomUUID(), controllerIdentity: 'test-controller' };
  const options = { source, control, project, operationId };
  const save = () => saveWorkerEngine(options);
  const verify = saved => verifyWorkerEngine({
    control, project, operationId, manifestSha256: saved.manifestSha256,
  });
  const record = async () => {
    const journal = await createWorkerJournal(control, owner);
    try { await journal.record({ version: 1, owner, phase: 'intent', domain: null }); }
    finally { await journal.close(); }
  };
  return { root, project, source, control, operationId, owner, options, save, verify, record };
}

function execute(command) {
  return new Promise((resolve, reject) => {
    const child = execFile(command.file, command.args, {
      env: command.env, timeout: 20000, maxBuffer: 8192, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(command.input ?? '');
  });
}

test('saved worker engine contains only the closed helper set and a pinned complete manifest', async t => {
  const { save, verify, project, operationId } = await fixture(t);
  const saved = await save();
  assert.deepEqual((await readdir(saved.directory)).sort(), [...files, 'manifest.json'].sort());
  const manifestBytes = await readFile(path.join(saved.directory, 'manifest.json'));
  assert.equal(saved.manifestSha256, digest(manifestBytes));
  const manifest = JSON.parse(manifestBytes);
  assert.deepEqual(Object.keys(manifest).sort(), ['files', 'operationId', 'project', 'version']);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.project, project);
  assert.equal(manifest.operationId, operationId);
  assert.deepEqual(manifest.files.map(entry => entry.name), files);
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(saved.directory, entry.name));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, digest(bytes));
  }
  assert.deepEqual(await verify(saved), saved);
  assert.equal(Object.isFrozen(saved), true);
});

test('saved inspection runs after the checkout disappears and never authorizes recovery', async t => {
  const { save, verify, record, owner, project, control } = await fixture(t);
  await record();
  const saved = await save();
  const before = await readdir(control);
  await rename(project, `${project}-replaced`);
  assert.deepEqual(await verify(saved), saved);
  const output = await execute(workerInspectionInvocation(saved, owner));
  assert.equal(output.code, 0, output.stderr);
  assert.equal(output.stderr, '');
  assert.deepEqual(JSON.parse(output.stdout), {
    status: 'inspection-only', phase: 'intent', recoveryAuthorized: false,
  });
  assert.deepEqual(await readdir(control), before);
  const journal = await readFile(path.join(control, `worker-${owner.workerId}.ndjson`), 'utf8');
  assert.equal(journal.split('\n').length, 2);
});

test('saved modules import without the source checkout or application node_modules', async t => {
  const { save, project } = await fixture(t);
  const saved = await save();
  await rename(project, `${project}-removed`);
  const urls = files.filter(file => file.endsWith('.mjs')
    && !['saved-worker-inspect.mjs', 'linux-worker-bootstrap.mjs'].includes(file))
    .map(file => pathToFileURL(path.join(saved.directory, file)).href);
  const output = await execute({
    file: process.execPath,
    args: ['--input-type=module', '-e', `for (const url of ${JSON.stringify(urls)}) await import(url);`],
    env: process.env,
  });
  assert.equal(output.code, 0, output.stderr);
});

test('source changes after saving cannot alter independently copied helpers', async t => {
  const { save, verify, source } = await fixture(t);
  const saved = await save();
  const copied = await readFile(path.join(saved.directory, 'owned-worker.mjs'));
  await writeFile(path.join(source, 'owned-worker.mjs'), 'throw new Error("source replaced");');
  assert.deepEqual(await readFile(path.join(saved.directory, 'owned-worker.mjs')), copied);
  assert.deepEqual(await verify(saved), saved);
});

test('duplicate or racing saves never overwrite or allocate extra engine slots', async t => {
  const { save, control, verify } = await fixture(t);
  const results = await Promise.allSettled([save(), save()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const saved = results.find(result => result.status === 'fulfilled').value;
  await assert.rejects(save(), /engine|exist/i);
  assert.deepEqual(await verify(saved), saved);
  assert.deepEqual(await readdir(control), ['worker-engine']);
});

test('incomplete engine is retained and cannot be mistaken for complete or overwritten', async t => {
  const { control, source, save, verify } = await fixture(t);
  await rename(path.join(source, 'worker-errors.mjs'), path.join(source, 'worker-errors-missing.mjs'));
  await assert.rejects(save());
  const directory = path.join(control, 'worker-engine');
  const entries = await readdir(directory);
  assert.equal(entries.includes('manifest.json'), false);
  await assert.rejects(verify({ manifestSha256: 'a'.repeat(64) }));
  await assert.rejects(save());
  assert.deepEqual(await readdir(directory), entries);
});

test('manifest digest, operation and project identity are required before using the bundle', async t => {
  const { save, control, project, operationId } = await fixture(t);
  const saved = await save();
  for (const mutation of [
    { manifestSha256: 'a'.repeat(64) }, { manifestSha256: '' },
    { operationId: 'other' }, { project: `${project}-other` },
  ]) {
    await assert.rejects(verifyWorkerEngine({
      control, project, operationId, manifestSha256: saved.manifestSha256, ...mutation,
    }));
  }
});

test('same-length helper corruption fails verification', async t => {
  const { save, verify } = await fixture(t);
  const saved = await save();
  const file = path.join(saved.directory, 'worker-errors.mjs');
  const bytes = await readFile(file);
  bytes[0] ^= 1;
  await writeFile(file, bytes);
  await assert.rejects(verify(saved), /hash|digest|changed/i);
});

test('unlisted saved files are not silently imported or ignored', async t => {
  const { save, verify } = await fixture(t);
  const saved = await save();
  await writeFile(path.join(saved.directory, 'unexpected.mjs'), 'export const bad = true;');
  await assert.rejects(verify(saved), /entries|files|unexpected/i);
});

test('malformed and unsupported manifests fail even when their new digest is supplied', async t => {
  const { save, verify } = await fixture(t);
  const saved = await save();
  const file = path.join(saved.directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  for (const content of [
    '{"version":', JSON.stringify({ ...manifest, version: 2 }),
    JSON.stringify({ ...manifest, secret: 'not-allowed' }),
    JSON.stringify({ ...manifest, files: manifest.files.slice(1) }),
    JSON.stringify({ ...manifest, files: [...manifest.files].reverse() }),
    'x'.repeat(32769),
  ]) {
    await writeFile(file, content);
    await assert.rejects(verify({ ...saved, manifestSha256: digest(content) }));
  }
});

test('unverified journal code cannot execute as part of saved inspection', async t => {
  const { save, record, owner, root } = await fixture(t);
  await record();
  const saved = await save();
  const sentinel = path.join(root, 'must-not-exist');
  await writeFile(path.join(saved.directory, 'worker-journal.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed');`);
  const result = await execute(workerInspectionInvocation(saved, owner));
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /inspection failed/i);
  await assert.rejects(stat(sentinel), { code: 'ENOENT' });
});

test('inspection rejects invalid arguments, oversized or malformed input without success output', async t => {
  const { save, record, owner } = await fixture(t);
  await record();
  const saved = await save();
  const command = workerInspectionInvocation(saved, owner);
  for (const mutation of [
    { args: [saved.entrypoint] }, { input: '{}' }, { input: '{' },
    { input: 'x'.repeat(32769) }, { input: JSON.stringify({ ...owner, operationId: 'foreign' }) },
  ]) {
    const result = await execute({ ...command, ...mutation });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.ok(Buffer.byteLength(result.stderr) < 1024);
  }
});

test('inspection invocation removes all Node preloads without mutating the parent environment', async t => {
  const { save, record, owner, root } = await fixture(t);
  await record();
  const saved = await save();
  const preload = path.join(root, 'preload.cjs');
  await writeFile(preload, 'throw new Error("bootstrap preload executed");');
  const keys = process.platform === 'win32' ? ['NODE_OPTIONS', 'NODE_PATH']
    : ['NODE_OPTIONS', 'node_options', 'Node_Path', 'NODE_PATH'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = key.toUpperCase() === 'NODE_OPTIONS'
      ? `--require ${JSON.stringify(preload)}` : root;
    const command = workerInspectionInvocation(saved, owner);
    assert.equal(Object.keys(command.env).some(key => ['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())), false);
    assert.equal(process.env.NODE_PATH, root);
    assert.equal(command.file, process.execPath);
    const result = await execute(command);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('hardlinked source files cannot become saved executable evidence', async t => {
  const { save, source, root } = await fixture(t);
  await link(path.join(source, 'owned-worker.mjs'), path.join(root, 'alias.mjs'));
  await assert.rejects(save(), /link|file/i);
});

test('Linux saved helpers and manifests are private and reject linked sources', {
  skip: process.platform !== 'linux',
}, async t => {
  const first = await fixture(t);
  const saved = await first.save();
  assert.equal((await stat(saved.directory)).mode & 0o777, 0o700);
  for (const name of [...files, 'manifest.json']) {
    assert.equal((await stat(path.join(saved.directory, name))).mode & 0o777, 0o600);
  }
  const second = await fixture(t);
  const sourceFile = path.join(second.source, 'owned-worker.mjs');
  await rename(sourceFile, `${sourceFile}.original`);
  await symlink(`${sourceFile}.original`, sourceFile);
  await assert.rejects(second.save(), /link|file/i);
});

test('source mutation during copying leaves an incomplete engine without a completion manifest', async t => {
  const { save, source, control } = await fixture(t);
  const file = path.join(source, 'worker-errors.mjs');
  const original = await readFile(file);
  const probe = await open(file, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const write = prototype.writeFile;
  let changed = false;
  t.mock.method(prototype, 'writeFile', async function (bytes) {
    await write.call(this, bytes);
    if (Buffer.isBuffer(bytes) && bytes.equals(original)) {
      changed = true;
      await writeFile(file, 'export const replaced = true;');
    }
  });
  await assert.rejects(save(), /source changed/i);
  t.mock.restoreAll();
  assert.equal(changed, true);
  assert.equal((await readdir(path.join(control, 'worker-engine'))).includes('manifest.json'), false);
  await assert.rejects(save(), /exist/i);
});

test('copy flush failure retains an incomplete engine and never retries into another directory', async t => {
  const { save, control, source } = await fixture(t);
  const probe = await open(path.join(source, 'owned-worker.mjs'), 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = prototype.sync;
  const failure = new Error('copy flush failed');
  t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isFile()) throw failure;
    return sync.call(this);
  });
  await assert.rejects(save(), error => error === failure);
  t.mock.restoreAll();
  assert.equal((await readdir(path.join(control, 'worker-engine'))).includes('manifest.json'), false);
  await assert.rejects(save(), /exist/i);
  assert.deepEqual(await readdir(control), ['worker-engine']);
});

test('noncanonical project identity cannot be persisted into a saved engine', async t => {
  const { options, project, control } = await fixture(t);
  await assert.rejects(saveWorkerEngine({ ...options, project: `${project}${path.sep}.` }), /canonical|identity/i);
  assert.deepEqual(await readdir(control), []);
});

test('large source files are rejected before allocating their contents as a saved helper', async t => {
  const { save, source, control } = await fixture(t);
  await writeFile(path.join(source, 'owned-worker.mjs'), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(save(), /size/i);
  assert.equal((await readdir(path.join(control, 'worker-engine'))).includes('manifest.json'), false);
});

test('inspection invocation rejects a substituted entrypoint instead of running an arbitrary file', async t => {
  const { save, owner } = await fixture(t);
  const saved = await save();
  for (const mutation of [
    { entrypoint: process.execPath }, { directory: 'relative/worker-engine' },
    { manifestSha256: 'invalid' }, { command: 'unexpected' },
  ]) assert.throws(() => workerInspectionInvocation({ ...saved, ...mutation }, owner));
});
