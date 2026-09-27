import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';
import { runOwnedWorker } from '../scripts/deployment/owned-worker.mjs';
import { createWorkerJournal, readWorkerJournal } from '../scripts/deployment/worker-journal.mjs';

async function fixture(t) {
  const root = await temporaryDeployment(t);
  const project = path.join(root, 'project');
  const control = path.join(root, '.project.deployment');
  await mkdir(project);
  await mkdir(control, { mode: 0o700 });
  const owner = {
    project, operationId: 'update-1', workerId: randomUUID(), controllerIdentity: 'fixture-controller',
  };
  const domain = {
    kind: 'systemd', bootId: randomUUID(), manager: 'system',
    unit: `agents-deploy-${owner.workerId}.service`, invocationId: 'a'.repeat(32),
    controlGroup: `/system.slice/agents-deploy-${owner.workerId}.service`,
  };
  const file = path.join(control, `worker-${owner.workerId}.ndjson`);
  const receipt = (phase, identity = phase === 'intent' ? null : domain) =>
    ({ version: 1, owner, phase, domain: identity });
  const create = async () => {
    const journal = await createWorkerJournal(control, owner);
    t.after(() => journal.close());
    return journal;
  };
  return { root, project, control, owner, domain, file, receipt, create };
}

function unsafe(error) {
  assert.equal(error.code, 'DEPLOYMENT_WORKER_UNSETTLED');
  assert.equal(error.recoveryAllowed, false);
  return true;
}

test('receipt journal survives close and cannot be reopened for writing', async t => {
  const { create, control, owner, receipt, file } = await fixture(t);
  const journal = await create();
  await journal.record(receipt('intent'));
  await journal.close();
  const records = await readWorkerJournal(control, owner);
  assert.deepEqual(records, [receipt('intent')]);
  assert.equal(Object.isFrozen(records), true);
  assert.equal(Object.isFrozen(records[0].owner), true);
  await assert.rejects(createWorkerJournal(control, owner), unsafe);
  await assert.rejects(journal.record(receipt('owned')), unsafe);
  assert.equal((await readFile(file, 'utf8')).split('\n').length, 2);
});

test('coordinator persists both native identity paths before admission and evidence retirement', async t => {
  for (const kind of ['systemd', 'windows-job']) {
    const { create, control, owner, domain } = await fixture(t);
    const identity = kind === 'systemd' ? domain : {
      kind, name: `Local\\agents-deploy-${owner.workerId}`, generation: owner.workerId,
      accountSid: 'S-1-5-18', sessionId: 0, ownerIdentity: owner.controllerIdentity,
    };
    const journal = await create();
    const result = await runOwnedWorker({ owner }, {
      record: journal.record,
      async prepare() {
        assert.equal((await readWorkerJournal(control, owner)).at(-1).phase, 'intent');
        return {
          identity,
          async run() {
            assert.equal((await readWorkerJournal(control, owner)).at(-1).phase, 'admitted');
            return 42;
          },
          async closeAdmission() {},
          async stop() {},
          async join() {},
          async observe() { return { identity, empty: true }; },
          async retire() {
            assert.equal((await readWorkerJournal(control, owner)).at(-1).phase, 'settled');
          },
        };
      },
    });
    assert.equal(result, 42);
    await journal.close();
    const records = await readWorkerJournal(control, owner);
    assert.deepEqual(records.map(record => record.phase), ['intent', 'owned', 'admitted', 'settled']);
    assert.deepEqual(records.at(-1).domain, identity);
    assert.equal(Object.isFrozen(records.at(-1).domain), true);
  }
});

test('cancelled intent records settlement without inventing a domain', async t => {
  const { create, control, owner } = await fixture(t);
  const journal = await create();
  const controller = new AbortController();
  const reason = new Error('cancel before native creation');
  await assert.rejects(runOwnedWorker({ owner, signal: controller.signal }, {
    async record(receipt) {
      await journal.record(receipt);
      if (receipt.phase === 'intent') controller.abort(reason);
    },
    async prepare() { assert.fail('must not prepare'); },
  }), error => error === reason);
  assert.deepEqual((await readWorkerJournal(control, owner)).map(record => [record.phase, record.domain]),
    [['intent', null], ['settled', null]]);
});

test('ambiguous native creation persists blocked and does not authorize subsequent settlement', async t => {
  const { create, control, owner, receipt } = await fixture(t);
  const journal = await create();
  await assert.rejects(runOwnedWorker({ owner }, {
    record: journal.record,
    async prepare() { throw new Error('lost creation reply'); },
  }), unsafe);
  assert.equal((await readWorkerJournal(control, owner)).at(-1).phase, 'blocked');
  await assert.rejects(journal.record(receipt('settled')), unsafe);
  assert.equal((await readWorkerJournal(control, owner)).at(-1).phase, 'blocked');
});

test('retirement failure can append blocked after a durable settlement', async t => {
  const { create, control, owner, receipt } = await fixture(t);
  const journal = await create();
  for (const phase of ['intent', 'owned', 'admitted', 'settled', 'blocked']) {
    await journal.record(receipt(phase));
  }
  assert.equal((await readWorkerJournal(control, owner)).length, 5);
  await assert.rejects(journal.record(receipt('blocked')), unsafe);
});

test('exclusive creation arbitrates racing creators without replacing the winner', async t => {
  const { control, owner, receipt } = await fixture(t);
  const results = await Promise.allSettled([
    createWorkerJournal(control, owner), createWorkerJournal(control, owner),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  unsafe(results.find(result => result.status === 'rejected').reason);
  const journal = results.find(result => result.status === 'fulfilled').value;
  t.after(() => journal.close());
  await journal.record(receipt('intent'));
  assert.equal((await readWorkerJournal(control, owner)).length, 1);
});

test('concurrent and duplicate appends do not queue stale transitions', async t => {
  const { create, receipt, control, owner } = await fixture(t);
  const journal = await create();
  const results = await Promise.allSettled([
    journal.record(receipt('intent')), journal.record(receipt('intent')),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  unsafe(results.find(result => result.status === 'rejected').reason);
  await assert.rejects(journal.record(receipt('intent')), unsafe);
  assert.equal((await readWorkerJournal(control, owner)).length, 1);
});

test('owner, domain, transition and extra-field substitutions cannot change the journal', async t => {
  const { create, receipt, owner, control, domain } = await fixture(t);
  const journal = await create();
  await journal.record(receipt('intent'));
  await journal.record(receipt('owned'));
  for (const invalid of [
    { ...receipt('admitted'), owner: { ...owner, operationId: 'other' } },
    { ...receipt('admitted'), owner: { ...owner, controllerIdentity: 'other' } },
    receipt('admitted', { ...domain, invocationId: 'b'.repeat(32) }),
    receipt('admitted', null),
    receipt('intent'),
    { ...receipt('admitted'), environment: { TOKEN: 'not-a-secret-fixture' } },
    { ...receipt('admitted'), version: 2 },
  ]) await assert.rejects(journal.record(invalid), unsafe);
  assert.deepEqual((await readWorkerJournal(control, owner)).map(record => record.phase), ['intent', 'owned']);
  await journal.record(receipt('admitted'));
});

test('caller mutation after starting an append cannot rewrite the saved receipt', async t => {
  const { create, receipt, control, owner } = await fixture(t);
  const journal = await create();
  const input = structuredClone(receipt('intent'));
  const append = journal.record(input);
  input.owner.operationId = 'changed';
  input.phase = 'blocked';
  await append;
  assert.deepEqual(await readWorkerJournal(control, owner), [receipt('intent')]);
});

test('empty, partial, oversized and malformed journals fail closed without repair', async t => {
  for (const content of [
    '', '{"version":1,', '{}\n', 'x'.repeat(128 * 1024 + 1),
  ]) {
    const { control, owner, file } = await fixture(t);
    await writeFile(file, content, { mode: 0o600 });
    await assert.rejects(readWorkerJournal(control, owner), unsafe);
    await assert.rejects(createWorkerJournal(control, owner), unsafe);
    assert.equal(await readFile(file, 'utf8'), content);
  }
});

test('partial trailing append is never ignored as an older successful receipt', async t => {
  const { create, receipt, control, owner, file } = await fixture(t);
  const journal = await create();
  await journal.record(receipt('intent'));
  await journal.close();
  const content = await readFile(file, 'utf8');
  await writeFile(file, `${content}{"version":1`);
  await assert.rejects(readWorkerJournal(control, owner), unsafe);
});

test('a foreign operation cannot read a same-name journal as its own evidence', async t => {
  const { create, receipt, control, owner } = await fixture(t);
  const journal = await create();
  await journal.record(receipt('intent'));
  await assert.rejects(readWorkerJournal(control, { ...owner, operationId: 'other' }), unsafe);
});

test('external byte changes poison the writer even if the old contents are restored', async t => {
  const { create, receipt, file } = await fixture(t);
  const journal = await create();
  await journal.record(receipt('intent'));
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('update-1', 'update-2'));
  await assert.rejects(journal.record(receipt('owned')), unsafe);
  await writeFile(file, original);
  await assert.rejects(journal.record(receipt('owned')), unsafe);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('named file replacement never redirects the retained writer', async t => {
  const { create, receipt, file } = await fixture(t);
  const journal = await create();
  await journal.record(receipt('intent'));
  const original = await readFile(file, 'utf8');
  await rename(file, `${file}.original`);
  await writeFile(file, original, { mode: 0o600 });
  await assert.rejects(journal.record(receipt('owned')), unsafe);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(await readFile(`${file}.original`, 'utf8'), original);
});

test('journal storage must be canonical and disjoint from the mutable checkout', async t => {
  const { project, root, owner } = await fixture(t);
  const inside = path.join(project, '.control');
  await mkdir(inside, { mode: 0o700 });
  for (const invalid of [project, inside, root]) {
    await assert.rejects(createWorkerJournal(invalid, owner), unsafe);
  }
});

test('hardlinked journal evidence is rejected without modifying either link', async t => {
  const { create, control, owner, receipt, file, root } = await fixture(t);
  const journal = await create();
  await journal.record(receipt('intent'));
  const alias = path.join(root, 'foreign-link');
  await link(file, alias);
  await assert.rejects(readWorkerJournal(control, owner), unsafe);
  await assert.rejects(journal.record(receipt('owned')), unsafe);
  assert.equal(await readFile(alias, 'utf8'), `${JSON.stringify(receipt('intent'))}\n`);
});

test('Linux storage enforces private modes and rejects linked roots and files', {
  skip: process.platform !== 'linux',
}, async t => {
  const { create, control, owner, receipt, file, root } = await fixture(t);
  const journal = await create();
  await journal.record(receipt('intent'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await chmod(control, 0o755);
  await assert.rejects(readWorkerJournal(control, owner), unsafe);
  await chmod(control, 0o700);
  const alias = path.join(root, 'alias');
  await symlink(control, alias);
  await assert.rejects(readWorkerJournal(alias, owner), unsafe);
  await journal.close();
  await rename(file, `${file}.original`);
  await symlink(`${file}.original`, file);
  await assert.rejects(readWorkerJournal(control, owner), unsafe);
});
