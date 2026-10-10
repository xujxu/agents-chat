import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { cp, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporaryDeployment, acquireLock, releaseLock, recoverRetirement,
  retirementRecoveryInvocation, admissionFiles } from './deployment-fixture.mjs';
import { reconcileInterruptedOperation } from '../scripts/deployment/state.mjs';
import { saveRecoveryEngine, verifyRecoveryEngine } from '../scripts/deployment/saved-recovery-engine.mjs';

const sourceTree = fileURLToPath(new URL('../scripts/deployment/', import.meta.url));
const execute = promisify(execFile);

test('changed recovery controllers publish an immutable generation without replacing the legacy engine', async t => {
  const root = await temporaryDeployment(t);
  const source = path.join(root, 'source');
  const control = path.join(root, 'control');
  await cp(sourceTree, source, { recursive: true });
  await mkdir(control, { mode: 0o700 });
  const legacy = await saveRecoveryEngine({ source, control });
  if (process.platform === 'win32') {
    const { retirementRecoveryInvocation: direct } = await import('../scripts/deployment/saved-recovery-engine.mjs');
    const options = { control, project: path.join(root, 'app'), operationId: 'runtime-binding' };
    assert.throws(() => direct(legacy, options), /explicit canonical PowerShell/);
    assert.deepEqual(retirementRecoveryInvocation(legacy, options).args.slice(-2),
      ['worker', process.env.DEPLOYMENT_TEST_PWSH]);
    assert.deepEqual(direct(legacy, {
      ...options, kind: 'task', pwsh: process.env.DEPLOYMENT_TEST_PWSH,
    }).args.slice(-2), ['task', process.env.DEPLOYMENT_TEST_PWSH]);
  } else {
    assert.throws(() => retirementRecoveryInvocation(legacy, {
      control, project: path.join(root, 'app'), operationId: 'runtime-binding', kind: 'task',
    }), /Invalid saved recovery invocation/);
  }
  const original = await readFile(path.join(legacy.directory, 'manifest.json'));
  const helper = path.join(source, 'linux-readiness.mjs');
  await writeFile(helper, `${await readFile(helper, 'utf8')}\n// Next controller generation.\n`);
  await assert.rejects(saveRecoveryEngine({ source, control }));
  const changed = await saveRecoveryEngine({ source, control, allowVersionChange: true });
  assert.notEqual(changed.manifestSha256, legacy.manifestSha256);
  assert.equal(changed.directory, path.join(control, `recovery-engine-${changed.manifestSha256}`));
  assert.deepEqual(await readFile(path.join(legacy.directory, 'manifest.json')), original);
  assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: legacy.manifestSha256 }), legacy);
  assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: changed.manifestSha256 }), changed);
  assert.deepEqual(await saveRecoveryEngine({ source, control, allowVersionChange: true }), changed);
  assert.equal(retirementRecoveryInvocation(changed, {
    control, project: path.join(root, 'app'), operationId: 'version-change',
  }).args[0], changed.entrypoint);
  assert.deepEqual((await readdir(control)).sort(), [
    'recovery-engine', `recovery-engine-${changed.manifestSha256}`,
  ]);
});

test('interrupted engine publication preserves legacy bytes and refuses unclassified staging on retry', async t => {
  const root = await temporaryDeployment(t);
  const source = path.join(root, 'source');
  const control = path.join(root, 'control');
  await cp(sourceTree, source, { recursive: true });
  await mkdir(control, { mode: 0o700 });
  const legacy = await saveRecoveryEngine({ source, control });
  const helper = path.join(source, 'linux-readiness.mjs');
  await writeFile(helper, `${await readFile(helper, 'utf8')}\n// Interrupted generation.\n`);
  const original = fs.rename;
  let staging;
  fs.rename = async (...args) => {
    if (String(args[0]).startsWith(`${control}${path.sep}recovery-engine-`)) {
      staging = args[0];
      throw new Error('publication interrupted before rename');
    }
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(saveRecoveryEngine({ source, control, allowVersionChange: true }), /publication interrupted/);
  } finally {
    fs.rename = original;
    syncBuiltinESMExports();
  }
  assert.ok(staging);
  const retained = await readFile(path.join(staging, 'manifest.json'));
  await assert.rejects(saveRecoveryEngine({ source, control, allowVersionChange: true }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(path.join(staging, 'manifest.json')), retained);
  assert.deepEqual(await verifyRecoveryEngine({ control, manifestSha256: legacy.manifestSha256 }), legacy);
  assert.deepEqual((await readdir(control)).sort(), ['recovery-engine', path.basename(staging)]);
});

test('saved recovery bundle closes module dependencies after its source disappears', async t => {
  const root = await temporaryDeployment(t);
  const source = path.join(root, 'source');
  const control = path.join(root, 'control');
  await cp(sourceTree, source, { recursive: true });
  await mkdir(control, { mode: 0o700 });
  const saved = await saveRecoveryEngine({ source, control });
  await rename(source, `${source}.displaced`);
  const names = new Set(await readdir(saved.directory));
  for (const name of names) {
    if (!name.endsWith('.mjs')) continue;
    const text = await readFile(path.join(saved.directory, name), 'utf8');
    for (const [, dependency] of text.matchAll(/['"]\.\/([^'"]+\.mjs)['"]/g)) {
      assert.ok(names.has(dependency), `${name} requires missing saved dependency ${dependency}`);
    }
  }
  assert.ok(names.has('windows-first-install-controller.ps1'));
  assert.ok(names.has('windows-first-runtime.ps1'));
  assert.ok(names.has('windows-first-task.ps1'));
  assert.ok(names.has('windows-first-task-registration.ps1'));
  assert.ok(names.has('windows-first-activation-handoff.ps1'));
  assert.ok(names.has('windows-first-activation.ps1'));
  assert.ok(names.has('windows-first-completion-handoff.ps1'));
  assert.ok(names.has('windows-first-completion.ps1'));
  const modules = [
    'linux-restore.mjs', 'linux-service-recovery.mjs', 'retirement-recovery.mjs',
    'windows-configuration.mjs', 'windows-first-install.mjs', 'windows-first-runtime.mjs',
  ];
  const urls = modules.map(name => pathToFileURL(path.join(saved.directory, name)).href);
  await execute(process.execPath, ['--input-type=module', '--eval',
    `for (const url of ${JSON.stringify(urls)}) await import(url);`], {
    cwd: root, timeout: 30000, maxBuffer: 8192,
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase()))),
  });
});

async function fixture(t, outcome = 'accepted') {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'app');
  const control = path.join(root, 'ctl');
  const source = path.join(project, 'scripts', 'deployment');
  await cp(sourceTree, source, { recursive: true });
  await mkdir(control, { mode: 0o700 });
  await mkdir(path.join(control, 'backup'));
  await writeFile(path.join(control, 'backup', 'sentinel'), 'retained backup');
  const engine = await saveRecoveryEngine({ source, control });
  const child = fork(new URL('./deployment-retirement-child.mjs', import.meta.url),
    [control, project, source, '', outcome], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const { lock, saved } = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Cleanup owner exited ${code}: ${diagnostic}`)));
  });
  const invoke = () => retirementRecoveryInvocation(engine, { control, project, operationId: lock.operationId });
  const recover = async () => {
    const command = invoke();
    return execute(command.file, command.args, { env: command.env, timeout: 45000, maxBuffer: 8192 });
  };
  const kill = async () => { child.kill('SIGKILL'); await exited; };
  return { root, project, control, source, engine, lock, saved, kill, recover };
}

test('independent saved recovery finishes partial retirement after original checkout disappears', async t => {
  const f = await fixture(t);
  await f.kill();
  const state = await readFile(path.join(f.control, 'state.json'));
  await rename(f.project, `${f.project}.displaced`);
  const result = JSON.parse((await f.recover()).stdout);
  assert.deepEqual(result, { status: 'retired', operationId: f.lock.operationId, restored: false });
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'recovery-engine', 'state.json', ...admissionFiles]);
  assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
  assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained backup');
  await mkdir(f.project);
  const lock = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
  await releaseLock(f.control, lock);
});

test('live original owner cannot be adopted and failure creates no recovery guard', async t => {
  const f = await fixture(t);
  const marker = await readFile(path.join(f.control, 'worker-retirement.json'));
  await assert.rejects(f.recover());
  assert.deepEqual(await readFile(path.join(f.control, 'worker-retirement.json')), marker);
  assert.ok(!(await readdir(f.control)).includes('recovery-lock'));
});

test('cold worker retirement preserves failed-update evidence after verified prior-runtime recovery', async t => {
  const f = await fixture(t, 'prior-runtime-restored');
  await f.kill();
  const state = await readFile(path.join(f.control, 'state.json'));
  assert.equal(JSON.parse(state).errorCode, 'BACKUP_FAILED');
  const result = JSON.parse((await f.recover()).stdout);
  assert.deepEqual(result, { status: 'retired', operationId: f.lock.operationId, restored: false });
  assert.deepEqual(await readFile(path.join(f.control, 'state.json')), state);
  assert.equal((await reconcileInterruptedOperation(f.control)).status, 'prior-runtime-restored');
  assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained backup');
  const next = await acquireLock(f.control, { project: f.project, operationId: randomUUID() });
  await releaseLock(f.control, next);
});

test('saved cold worker cleanup refuses service maintenance evidence without deleting anything', async t => {
  const f = await fixture(t);
  await f.kill();
  await writeFile(path.join(f.control, 'service-stop.ndjson'), '{"partial":');
  const before = (await readdir(f.saved.directory)).sort();
  await assert.rejects(f.recover());
  assert.deepEqual((await readdir(f.saved.directory)).sort(), before);
  assert.ok((await readdir(f.control)).includes('lock'));
  assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
});

test('worker-only recovery cannot discard the lock beneath a live service retirement handoff', async t => {
  const f = await fixture(t);
  await f.kill();
  await writeFile(path.join(f.control, 'live-retirement.json'), '{"partial":');
  const before = (await readdir(f.saved.directory)).sort();
  await assert.rejects(f.recover());
  assert.deepEqual((await readdir(f.saved.directory)).sort(), before);
  assert.ok((await readdir(f.control)).includes('lock'));
  assert.ok(!(await readdir(f.control)).includes('recovery-lock'));
});

test('malformed or foreign deletion evidence is rejected before any additional deletion', async t => {
  for (const mode of ['truncated', 'path', 'state', 'foreign']) {
    const f = await fixture(t);
    await f.kill();
    const file = path.join(f.control, 'worker-retirement.json');
    const marker = JSON.parse(await readFile(file, 'utf8'));
    if (mode === 'truncated') await writeFile(file, '{"version":2,');
    if (mode === 'path') {
      marker.files[0].path = path.join('backup', 'sentinel');
      await writeFile(file, JSON.stringify(marker));
    }
    if (mode === 'state') await writeFile(path.join(f.control, 'state.json'), '{}');
    if (mode === 'foreign') await writeFile(path.join(f.saved.directory, 'foreign'), 'untouched');
    const before = (await readdir(f.saved.directory)).sort();
    await assert.rejects(f.recover());
    assert.deepEqual((await readdir(f.saved.directory)).sort(), before);
    assert.equal(await readFile(path.join(f.control, 'backup', 'sentinel'), 'utf8'), 'retained backup');
    assert.ok((await readdir(f.control)).includes('lock'));
  }
});

test('concurrent saved recovery processes cannot both acquire cleanup authority', async t => {
  const f = await fixture(t);
  await f.kill();
  const results = await Promise.allSettled([f.recover(), f.recover()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.deepEqual((await readdir(f.control)).sort(), ['backup', 'recovery-engine', 'state.json', ...admissionFiles]);
});

test('preexisting incomplete recovery guard blocks recovery and ordinary lock operations', async t => {
  const f = await fixture(t);
  await f.kill();
  await mkdir(path.join(f.control, 'recovery-lock'), { mode: 0o700 });
  await assert.rejects(f.recover());
  await assert.rejects(acquireLock(f.control, { project: f.project, operationId: 'new' }));
  const root = await temporaryDeployment(t);
  const lock = await acquireLock(root, { project: root, operationId: 'guard' });
  await mkdir(path.join(root, 'recovery-lock'), { mode: 0o700 });
  await assert.rejects(releaseLock(root, lock), /recovery/i);
});

test('fixed recovery bundle is reusable only for identical verified source', async t => {
  const f = await fixture(t);
  assert.deepEqual(await saveRecoveryEngine({ source: f.source, control: f.control }), f.engine);
  await writeFile(path.join(f.source, 'retirement-recovery.mjs'), 'changed');
  await assert.rejects(saveRecoveryEngine({ source: f.source, control: f.control }));
  await f.kill();
  await f.recover();
});

test('a gap in the deletion sequence cannot be interpreted as completed earlier cleanup', async t => {
  const f = await fixture(t);
  await f.kill();
  await unlink(path.join(f.control, 'worker-operation.ndjson'));
  const before = (await readdir(f.saved.directory)).sort();
  await assert.rejects(f.recover());
  assert.deepEqual((await readdir(f.saved.directory)).sort(), before);
  assert.ok(!(await readdir(f.control)).includes('recovery-lock'));
});

test('modified recovery code is refused before importing the cleanup implementation', async t => {
  const f = await fixture(t);
  await f.kill();
  await writeFile(path.join(f.engine.directory, 'retirement-recovery.mjs'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(path.join(f.control, 'executed'))},'bad');
    export function recoverRetirement(){return {status:'retired'}}
  `);
  await assert.rejects(f.recover());
  await assert.rejects(readFile(path.join(f.control, 'executed')), { code: 'ENOENT' });
  assert.ok((await readdir(f.control)).includes('lock'));
});

test('recovery deletion failure retains both original lock and exclusive cleanup authority', async t => {
  const f = await fixture(t);
  await f.kill();
  const unlink = fs.unlink;
  let deletes = 0;
  t.mock.method(fs, 'unlink', async file => {
    if (path.dirname(file) === f.saved.directory && ++deletes === 2) throw new Error('injected cleanup delete failure');
    return unlink(file);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(recoverRetirement({
      control: f.control, project: f.project, operationId: f.lock.operationId,
    }), { recoveryAllowed: false });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(deletes, 2);
  assert.ok((await readdir(f.control)).includes('lock'));
  assert.ok((await readdir(f.control)).includes('recovery-lock'));
  await assert.rejects(f.recover());
  await assert.rejects(acquireLock(f.control, { project: f.project, operationId: randomUUID() }), /recovery/i);
});

test('failed old-lock deletion leaves completion evidence and blocks ordinary deployment', async t => {
  const f = await fixture(t);
  await f.kill();
  const originalUnlink = fs.unlink;
  t.mock.method(fs, 'unlink', async file => {
    if (file === path.join(f.control, 'lock', 'owner.json')) throw new Error('injected old lock delete failure');
    return originalUnlink(file);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(recoverRetirement({
      control: f.control, project: f.project, operationId: f.lock.operationId,
    }), { recoveryAllowed: false });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const complete = JSON.parse(await readFile(path.join(f.control, 'recovery-lock', 'complete.json')));
  assert.equal(complete.status, 'retired');
  assert.equal(complete.operationId, f.lock.operationId);
  await assert.rejects(acquireLock(f.control, { project: f.project, operationId: randomUUID() }), /recovery/i);
});

test('recovery guard cannot be reported idle when the original deployment lock is already gone', async t => {
  const root = await temporaryDeployment(t);
  await mkdir(path.join(root, 'recovery-lock'), { mode: 0o700 });
  assert.equal((await reconcileInterruptedOperation(root)).status, 'blocked');
});

test('killed recovery controller leaves exclusive guard rather than permitting a second recovery', async t => {
  const f = await fixture(t);
  await f.kill();
  const child = fork(new URL('./deployment-recovery-child.mjs', import.meta.url),
    [f.control, f.project, f.lock.operationId, f.engine.manifestSha256],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Recovery fixture exited ${code}: ${stderr}`)));
  });
  child.kill('SIGKILL');
  await exited;
  assert.ok((await readdir(f.control)).includes('recovery-lock'));
  const remaining = (await readdir(f.saved.directory)).sort();
  await assert.rejects(f.recover());
  assert.deepEqual((await readdir(f.saved.directory)).sort(), remaining);
  assert.equal((await reconcileInterruptedOperation(f.control)).status, 'blocked');
});
