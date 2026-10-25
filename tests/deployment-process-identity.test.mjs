import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { processIdentity } from '../scripts/deployment/process-identity.mjs';

test('original process identity does not depend on inherited PATH', async () => {
  const original = await processIdentity(process.pid);
  assert.equal(typeof original, 'string');
  const prior = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.equal(await processIdentity(process.pid), original);
    delete process.env.PATH;
    assert.equal(await processIdentity(process.pid), original);
  } finally {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
});

test('Windows identity refuses missing or relative system tools without PATH fallback', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = process.env.SystemRoot;
  try {
    for (const value of ['', 'relative-system-root', 'C:\\Windows\n']) {
      process.env.SystemRoot = value;
      await assert.rejects(processIdentity(process.pid), /explicit absolute SystemRoot/);
    }
    delete process.env.SystemRoot;
    await assert.rejects(processIdentity(process.pid), /explicit absolute SystemRoot/);
  } finally {
    if (root === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = root;
  }
});

test('process identity rejects invalid original process identifiers', async () => {
  for (const pid of [0, -1, 1.5, NaN, '1', 2147483648]) {
    await assert.rejects(processIdentity(pid), /Invalid deployment process ID/);
  }
});

test('Windows identity observes exiting processes without inventing a live identity', {
  skip: process.platform !== 'win32',
}, async () => {
  for (const delay of [0, 50, 150, 300]) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = once(child, 'exit');
    await once(child, 'spawn');
    try {
      const original = await processIdentity(child.pid);
      assert.equal(typeof original, 'string');
      const pending = processIdentity(child.pid);
      const timer = setTimeout(() => child.kill(), delay);
      let observed;
      try { observed = await pending; }
      finally { clearTimeout(timer); }
      assert.ok(observed === null || observed === original);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    assert.equal(await processIdentity(child.pid), null);
  }
});
