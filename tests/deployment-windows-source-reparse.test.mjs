import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { temporaryDeployment } from './deployment-fixture.mjs';

const native = process.platform === 'win32';
const script = fileURLToPath(new URL('./deployment-windows-source-reparse.ps1', import.meta.url));

async function observer(project, relative, signal, { saved, decorate = false } = {}) {
  const child = spawn(process.env.DEPLOYMENT_TEST_PWSH ?? 'pwsh.exe', [
    '-NoProfile', '-NonInteractive', '-File', script, '-Project', project, '-Relative', relative,
    ...(saved ? ['-Saved', saved] : []), ...(decorate ? ['-Decorate'] : []),
  ], { stdio: ['pipe', 'pipe', 'pipe'], signal });
  let error = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { error += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout });
  const first = await lines[Symbol.asyncIterator]().next();
  if (first.done) {
    await exit;
    lines.close();
    throw new Error(`Native reparse observation failed: ${error}`);
  }
  return {
    child, record: JSON.parse(first.value),
    async close() {
      child.stdin.end('check\n');
      const result = await exit;
      lines.close();
      assert.deepEqual(result, { code: 0, signal: null }, error);
    },
  };
}

test('native source reparse observation retains an internal junction and its target without following foreign links',
  { skip: !native, timeout: 120000 }, async t => {
    const root = await temporaryDeployment(t);
    const project = path.join(root, 'app');
    const modules = path.join(project, 'node_modules');
    const target = path.join(modules, 'dependency');
    const output = path.join(project, '.next');
    await mkdir(target, { recursive: true });
    await mkdir(output);
    await writeFile(path.join(target, 'payload'), 'original dependency');
    const link = path.join(output, 'dependency');
    await symlink(target, link, 'junction');
    const retained = await observer(project, '.next/dependency', t.signal);
    try {
      assert.equal(retained.record.kind, 'junction');
      assert.equal(retained.record.target, '../node_modules/dependency');
      const raw = Buffer.from(retained.record.data, 'base64');
      assert.equal(raw.readUInt32LE(0), 0xa0000003);
      assert.equal(raw.readUInt16LE(4) + 8, raw.length);
      assert.equal(retained.record.attributes & 0x410, 0x410);
      assert.ok(retained.record.securityDescriptor.startsWith('O:'));
      for (const directory of [link, output, target, modules, project]) {
        await assert.rejects(rename(directory, `${directory}-moved`));
      }
      assert.equal(await readFile(path.join(link, 'payload'), 'utf8'), 'original dependency');
    } finally { await retained.close(); }
    await rename(link, `${link}-moved`);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel'), 'untouched');
    await symlink(outside, link, 'junction');
    await assert.rejects(observer(project, '.next/dependency', t.signal), /target is outside the project/i);
    assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'untouched');
    await assert.rejects(observer(project, '.next/dependency-moved/payload', t.signal), /reparse|redirected/i);
    await assert.rejects(observer(project, 'node_modules/dependency/payload', t.signal), /reparse/i);
    await symlink(project, path.join(output, 'root-link'), 'junction');
    await assert.rejects(observer(project, '.next/root-link', t.signal), /outside|project|reparse/i);
    await symlink(`${link}-moved`, path.join(output, 'chain'), 'junction');
    await assert.rejects(observer(project, '.next/chain', t.signal), /reparse|source changed/i);
  });

test('native junction recreation preserves reparse bytes and link ACLs without changing the target',
  { skip: !native, timeout: 120000 }, async t => {
    const root = await temporaryDeployment(t);
    const project = path.join(root, 'app');
    const target = path.join(project, 'node_modules/dependency');
    await mkdir(target, { recursive: true });
    await mkdir(path.join(project, '.next'));
    await writeFile(path.join(target, 'payload'), 'retained target');
    await symlink(target, path.join(project, '.next/original'), 'junction');
    const original = await observer(project, '.next/original', t.signal);
    const saved = path.join(root, 'junction.json');
    try { await writeFile(saved, JSON.stringify(original.record), { flag: 'wx', mode: 0o600 }); }
    finally { await original.close(); }
    const restored = await observer(project, '.next/restored', t.signal, { saved, decorate: true });
    let record;
    try {
      record = restored.record;
      assert.equal(record.kind, 'junction');
      assert.equal(record.data, original.record.data);
      assert.equal(record.attributes, original.record.attributes | 1 | 2);
      assert.match(record.securityDescriptor, /(?:WD|S-1-1-0)/);
      await assert.rejects(rename(path.join(project, '.next/restored'), path.join(project, '.next/moved')));
      assert.equal(await readFile(path.join(project, '.next/restored/payload'), 'utf8'), 'retained target');
    } finally { await restored.close(); }
    await writeFile(saved, JSON.stringify(record));
    const copied = await observer(project, '.next/copied', t.signal, { saved });
    try {
      assert.equal(copied.record.data, record.data);
      assert.equal(copied.record.attributes, record.attributes);
      assert.equal(copied.record.securityDescriptor, record.securityDescriptor);
    } finally { await copied.close(); }
    await assert.rejects(observer(project, '.next/copied', t.signal, { saved }), /Create original private directory/i);
    const outside = Buffer.from(record.data, 'base64');
    const component = Buffer.from('\\app\\', 'utf16le');
    let replacements = 0;
    for (let offset = outside.indexOf(component, 16); offset >= 0; offset = outside.indexOf(component, offset + component.length)) {
      Buffer.from('\\out\\', 'utf16le').copy(outside, offset);
      replacements++;
    }
    assert.ok(replacements > 0);
    const unsupported = Buffer.from(record.data, 'base64');
    unsupported.writeUInt32LE(0xa000000c, 0);
    for (const data of [Buffer.from('not a reparse buffer'), outside, unsupported]) {
      await writeFile(saved, JSON.stringify({ ...record, data: data.toString('base64') }));
      await assert.rejects(observer(project, '.next/invalid', t.signal, { saved }), /reparse/i);
      await assert.rejects(lstat(path.join(project, '.next/invalid')), { code: 'ENOENT' });
    }
    assert.equal(await readFile(path.join(target, 'payload'), 'utf8'), 'retained target');
  });
