import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { readWorkerFile } from './worker-files.mjs';
import { captureWorkerCommand } from './worker-wire.mjs';
import { databaseProfile } from './database-shape-policy.mjs';

const modulePaths = Object.freeze([
  'scripts/deployment/database-compatibility.mjs', 'scripts/deployment/database-shape-policy.mjs',
  'scripts/deployment/database-content.mjs', 'scripts/deployment/snapshot-files.mjs',
  'lib/workflow/workflowSchema.mjs',
]);
const checks = Object.freeze([
  'database-version', 'schema-bound', 'table-inventory', 'partial-table-group', 'missing-chat-group',
  'schema-definition', 'schema-metadata', 'migration-receipts', 'destructive-startup',
  'rollback-journal', 'orphan-sidecar', 'file-type', 'file-replaced', 'sqlite-header',
  'sidecar-inventory', 'file-close', 'unsupported-profile', 'database-inventory',
  'directory-replaced', 'inspection-unavailable', 'stored-content', 'stored-json',
  'database-integrity', 'database-foreign-key', 'stored-type-policy', 'stored-scalar',
  'stored-row-budget', 'stored-transfer', 'stored-transfer-digest',
]);
const origin = new URL('../../', import.meta.url);
const virtualRoot = 'agents-deployment:///';

export function databaseInspectionRefusal(check) {
  return Object.assign(new Error(`Database admission refused: ${check}.`), {
    code: 'DEPLOYMENT_DATABASE_UNSUPPORTED', check,
    nextAction: 'Inspect the installed data format and retained worker evidence before updating; do not initialize or migrate data to bypass admission.',
  });
}

async function databaseBootstrap() {
  const { gunzipSync } = await import('node:zlib');
  const { registerHooks } = await import('node:module');
  const payload = JSON.parse(gunzipSync(Buffer.from(process.argv[1], 'base64'),
    { maxOutputLength: 256 * 1024 }).toString('utf8'));
  const modules = new Map(payload.modules);
  const prefix = 'agents-deployment:///';
  registerHooks({
    resolve(specifier, context, next) {
      const url = specifier.startsWith(prefix) ? specifier
        : context.parentURL?.startsWith(prefix) && specifier.startsWith('.')
          ? new URL(specifier, context.parentURL).href : null;
      if (url === null) return next(specifier, context);
      if (!modules.has(url)) throw new Error('Inspector module is not in the captured registry.');
      return { url, shortCircuit: true };
    },
    load(url, context, next) {
      if (!url.startsWith(prefix)) return next(url, context);
      if (!modules.has(url)) throw new Error('Inspector module is not in the captured registry.');
      return { format: 'module', source: modules.get(url), shortCircuit: true };
    },
  });
  try {
    const { inspectDeploymentData } = await import(`${prefix}scripts/deployment/database-compatibility.mjs`);
    const result = await inspectDeploymentData({ project: process.argv[2], profile: process.argv[3] });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, check: error?.code === 'DEPLOYMENT_DATABASE_UNSUPPORTED'
      && payload.checks.includes(error.check) ? error.check : 'inspection-unavailable' }));
  }
}

export async function prepareDatabaseInspectionCommand({ project, node, profile, environment, signal }) {
  try {
    signal?.throwIfAborted();
    if (profile !== databaseProfile) throw databaseInspectionRefusal('unsupported-profile');
    const modules = [];
    for (const name of modulePaths) {
      signal?.throwIfAborted();
      const bytes = await readWorkerFile(fileURLToPath(new URL(name, origin)), 64 * 1024);
      modules.push([`${virtualRoot}${name}`, new TextDecoder('utf-8', { fatal: true }).decode(bytes)]);
    }
    for (let index = 0; index < modulePaths.length; index++) {
      signal?.throwIfAborted();
      const bytes = await readWorkerFile(fileURLToPath(new URL(modulePaths[index], origin)), 64 * 1024);
      if (!bytes.equals(Buffer.from(modules[index][1]))) throw databaseInspectionRefusal('inspector-changed');
    }
    const bytes = Buffer.from(JSON.stringify({ modules, checks }));
    if (bytes.length > 256 * 1024) throw databaseInspectionRefusal('inspector-budget');
    const payload = gzipSync(bytes).toString('base64');
    const code = `(${databaseBootstrap.toString()})().catch(()=>{process.stderr.write("Database worker bootstrap failed.\\n");process.exitCode=1;});`;
    const command = captureWorkerCommand({
      file: node, cwd: project, env: environment,
      args: ['--input-type=module', '--eval', code, '--', payload, project, profile],
    });
    if (command.args.join(' ').length > 28000) throw databaseInspectionRefusal('inspector-budget');
    return command;
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'DEPLOYMENT_DATABASE_UNSUPPORTED') throw error;
    throw databaseInspectionRefusal('inspector-capture');
  }
}

export function readDatabaseInspectionResult(output, profile) {
  try {
    if (profile !== databaseProfile || typeof output?.stdout !== 'string'
      || output.stdout.length > 1024 || output.stderr !== '') throw databaseInspectionRefusal('worker-result');
    const value = JSON.parse(output.stdout);
    if (value?.ok === false && checks.includes(value.check) && same(value, { ok: false, check: value.check })) {
      throw databaseInspectionRefusal(value.check);
    }
    const databases = value?.result?.databases;
    if (!Array.isArray(databases) || databases.length !== 2
      || databases.some((db, index) => !db || db.name !== ['chats.db', 'config.db'][index]
        || !['absent', 'data-supported'].includes(db.status))) throw databaseInspectionRefusal('worker-result');
    const result = { profile, databases: databases.map(db => ({ name: db.name, status: db.status })) };
    if (!same(value, { ok: true, result })) throw databaseInspectionRefusal('worker-result');
    return result;
  } catch (error) {
    if (error?.code === 'DEPLOYMENT_DATABASE_UNSUPPORTED') throw error;
    throw databaseInspectionRefusal('worker-result');
  }
}
