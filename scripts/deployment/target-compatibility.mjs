import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify, isDeepStrictEqual as same } from 'node:util';
import { realDirectory } from './snapshot-files.mjs';

const execute = promisify(execFile);
const baseline = '638c553c62406dbb7e6b5aeb41cdddf4cd6de179';
const profile = Object.freeze({
  version: 1, databaseProfile: 'agents-chat-638c553',
  configurationProfile: 'agents-chat-auth-638c553', runtimeProfile: 'agents-chat-node24-638c553',
});
const bindings = Object.freeze({
  'package.json': '7d3d4d85d4501d835a21594d651386040d34e611',
  'package-lock.json': '85f4f59c3549a2ccca17d5662fe85ad1153c35ac',
  'lib/chatStore.ts': 'aa201f3edc25e3d66bc76e9453c1cb3cda55db99',
  'lib/configStore.ts': '7f037928778e147cc68e46c550bf109759227765',
  'lib/chatSyncStore.ts': '005a819da01dff4e5dd512e40658ebdbdf4ebbb5',
  'lib/chatTransferStore.ts': 'bb03a556703881ff086aa958db22ebbe6bf0cc17',
  'lib/scheduler/scheduleStore.ts': 'ecb14acd9f5f1107094e9621ba4da7cb273e56cd',
  'lib/chatDeltaValidation.ts': 'db23d472dc027b0a4faba21bf458eeaa412faf38',
  'lib/chatSyncProtocol.ts': '292cc9704f031da8ba0093e45bfb7e605240d43d',
  'lib/workflow/workflowSchema.mjs': '8b32e2db5480eacf874dc2ea0bc57d635ae2cdec',
  'app/features/scheduler/scheduleSpec.ts': '4682a7cb55c9dd76a7cc54d2d4b3ae2571f2e095',
  'lib/auth.ts': '25a7f2115d53976733bdbdbec093e902852b41e4',
  'app/api/auth/[...nextauth]/route.ts': 'f5ae0ae509725efc21923232fa114d90c80489ac',
});
const protocols = Object.freeze([1, 2].map(snapshotVersion => Object.freeze({ version: 1, snapshotVersion })));
function refusal(check) {
  return Object.assign(new Error(`Target compatibility refused: ${check}.`), {
    code: 'DEPLOYMENT_TARGET_UNSUPPORTED', check,
    nextAction: 'Inspect the exact target declaration, reviewed source profile and Node runtime before updating.',
  });
}

export async function inspectTargetCompatibility({ project, commit, nodeVersion, platform, signal }) {
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw refusal('literal-commit');
  if (!['linux', 'win32'].includes(platform) || !/^24\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(nodeVersion ?? '')) {
    throw refusal('runtime-profile');
  }
  try {
    const root = await realDirectory(project);
    // Ignore controller Git redirection and replacement objects when reading the named checkout.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1' });
    const git = async (args, maxBuffer = 16384) => {
      signal?.throwIfAborted();
      return (await execute('git', ['--no-replace-objects', '-c', `safe.directory=${root}`, '-C', root, ...args], {
        env, signal, timeout: 30000, maxBuffer, windowsHide: true, encoding: 'buffer',
      })).stdout;
    };
    if ((await git(['cat-file', '-t', commit])).toString().trim() !== 'commit') throw refusal('commit-type');
    const entry = async file => {
      const output = (await git(['ls-tree', '-z', commit, '--', file])).toString('utf8');
      if (!output) return null;
      const match = output.match(/^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/);
      if (!match || match[2] !== file) throw refusal('target-file-type');
      return match[1];
    };
    const json = async file => {
      const object = await entry(file);
      if (!object) return null;
      const size = Number((await git(['cat-file', '-s', object])).toString().trim());
      if (!Number.isSafeInteger(size) || size < 1 || size > 16384) throw refusal('declaration-size');
      const bytes = await git(['cat-file', 'blob', object], 16384);
      if (bytes.length !== size || createHash('sha1').update(`blob ${size}\0`).update(bytes).digest('hex') !== object) {
        throw refusal('object-integrity');
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    };
    for (const [file, expected] of Object.entries(bindings)) {
      if (await entry(file) !== expected) throw refusal('unreviewed-source-profile');
    }
    const declaredProtocol = await json('scripts/deployment/protocol.json');
    const declaredProfile = await json('scripts/deployment/compatibility.json');
    const historical = commit === baseline;
    if (historical ? declaredProtocol !== null || declaredProfile !== null
      : !protocols.some(protocol => same(declaredProtocol, protocol)) || !same(declaredProfile, profile)) throw refusal('target-declaration');
    return {
      status: 'target-supported', commit, mode: historical ? 'historical' : 'declared',
      protocol: historical ? null : { ...declaredProtocol },
      databaseProfile: profile.databaseProfile, configurationProfile: profile.configurationProfile,
      runtimeProfile: profile.runtimeProfile,
      pendingChecks: [...(historical ? ['historical-adapter'] : []),
        'effective-configuration', 'database-shape', 'persisted-content', 'native-runtime'],
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'DEPLOYMENT_TARGET_UNSUPPORTED') throw error;
    throw refusal('target-inspection-unavailable');
  }
}
