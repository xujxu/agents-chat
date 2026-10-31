import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { realDirectory } from './snapshot-files.mjs';
import { readWorkerFile } from './worker-files.mjs';
import { inspectPersistedRow } from './database-content.mjs';

function refusal(check) {
  return Object.assign(new Error(`Database admission refused: ${check}.`), {
    code: 'DEPLOYMENT_DATABASE_UNSUPPORTED', check,
    nextAction: 'Inspect the historical agents.json or nodes.json before its first database import; do not initialize the store to bypass admission.',
  });
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string';
const identity = info => ({
  dev: info.dev, ino: info.ino, size: info.size, mode: info.mode,
  uid: info.uid, gid: info.gid, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, nlink: info.nlink,
});
async function capture(file) {
  let original;
  try { original = await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const bytes = await readWorkerFile(file, 1024 * 1024);
  if (!same(identity(original), identity(await lstat(file, { bigint: true })))) throw refusal('legacy-changed');
  return { bytes, identity: identity(original) };
}

function validate(bytes, name) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw refusal('legacy-json'); }
  const key = name === 'agents.json' ? 'agents' : 'nodes';
  if (!record(value) || !Array.isArray(value[key]) || value[key].length > 10000) throw refusal('legacy-content');
  const seen = new Set();
  for (const item of value[key]) {
    const id = item?.[key === 'agents' ? 'id' : 'name'];
    if (!record(item) || !text(id) || !id.trim() || seen.has(id)) throw refusal('legacy-content');
    seen.add(id);
    const fields = key === 'agents' ? ['name', 'command', 'cwd', 'relayConnectionName', 'defaultModelId'] : ['label'];
    if (fields.some(field => item[field] !== undefined && !text(item[field]))) throw refusal('legacy-content');
    if (key === 'nodes') continue;
    if (['yolo', 'noTools', 'relay'].some(field => item[field] !== undefined && typeof item[field] !== 'boolean')) {
      throw refusal('legacy-content');
    }
    inspectPersistedRow('agents', {
      args: JSON.stringify(item.args ?? []), env: JSON.stringify(item.env ?? {}),
      models: JSON.stringify(item.models ?? []), default_model_id: item.defaultModelId ?? '',
      yolo: item.yolo ? 1 : 0, no_tools: item.noTools ? 1 : 0,
      relay: item.relay ? 1 : 0, public: id === 'copilot' ? 1 : 0,
    }, () => refusal('legacy-content'));
  }
}

export async function inspectLegacyConfiguration({ project, signal }) {
  try {
    signal?.throwIfAborted();
    const root = await realDirectory(project);
    const originalRoot = identity(await lstat(root, { bigint: true }));
    const retained = [];
    for (const name of ['agents.json', 'nodes.json']) {
      signal?.throwIfAborted();
      const file = path.join(root, name);
      const observed = await capture(file);
      if (observed) validate(observed.bytes, name);
      retained.push({ name, file, observed });
    }
    const check = async () => {
      try {
        signal?.throwIfAborted();
        const currentRoot = await realDirectory(project);
        const info = await lstat(currentRoot, { bigint: true });
        if (currentRoot !== root || info.dev !== originalRoot.dev || info.ino !== originalRoot.ino) throw refusal('legacy-changed');
        for (const { file, observed } of retained) {
          signal?.throwIfAborted();
          if (!same(await capture(file), observed)) throw refusal('legacy-changed');
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.code === 'DEPLOYMENT_DATABASE_UNSUPPORTED') throw error;
        throw refusal('legacy-changed');
      }
    };
    await check();
    return Object.freeze({ status: 'legacy-supported', check });
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'DEPLOYMENT_DATABASE_UNSUPPORTED') throw error;
    throw refusal('legacy-inspection');
  }
}
