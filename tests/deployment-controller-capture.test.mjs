import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { temporaryDeployment } from './deployment-fixture.mjs';

async function sourceFixture(t) {
  const source = await temporaryDeployment(t);
  await mkdir(path.join(source, 'scripts/deployment'), { recursive: true });
  await mkdir(path.join(source, 'lib/workflow'), { recursive: true });
  await writeFile(path.join(source, 'scripts/deployment/linux-update-command.mjs'),
    'export async function observe() { return (await import("../../lib/workflow/workflowSchema.mjs")).value; }\n');
  await writeFile(path.join(source, 'lib/workflow/workflowSchema.mjs'), 'export const value = "captured";\n');
  return source;
}

test('captured controller keeps dynamic imports and helper files after source replacement', async t => {
  const { captureLinuxController } = await import('../scripts/deployment/linux-controller-capture.mjs');
  const source = await sourceFixture(t);
  const captured = await captureLinuxController({ source, project: source });
  t.after(() => captured.close());
  await rename(path.join(source, 'scripts'), path.join(source, 'old-scripts'));
  await rename(path.join(source, 'lib'), path.join(source, 'old-lib'));
  const controller = await import(pathToFileURL(captured.entrypoint).href);
  assert.equal(await controller.observe(), 'captured');
  assert.match(await readFile(path.join(path.dirname(captured.entrypoint), '../../lib/workflow/workflowSchema.mjs'), 'utf8'),
    /captured/);
  await captured.close();
  await assert.rejects(readdir(captured.directory), { code: 'ENOENT' });
});

test('controller capture refuses linked and unknown helper inventory before execution', async t => {
  const { captureLinuxController } = await import('../scripts/deployment/linux-controller-capture.mjs');
  for (const kind of ['link', 'directory', 'unknown']) {
    const source = await sourceFixture(t);
    const file = path.join(source, 'scripts/deployment/extra.mjs');
    if (kind === 'link') await symlink('linux-update-command.mjs', file);
    if (kind === 'directory') await mkdir(file);
    if (kind === 'unknown') await writeFile(path.join(source, 'scripts/deployment/secret.env'), 'not-controller-code');
    await assert.rejects(captureLinuxController({ source, project: source }), /controller|file|inventory|link/i);
  }
});
