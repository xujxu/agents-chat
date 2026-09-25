import assert from 'node:assert/strict';

export const sampleIds = ['test-00332', 'test-00949'] as const;
export const phases = ['initial', 'install', 'enabled', 'disable', 'disabled'] as const;
export type BrowserPhase = 'initial' | 'enabled' | 'disabled';
export type Delivery = {
  status: number; body: unknown; draft: string; composer: string; sends: number;
  sourceCompleted: boolean; tracksStopped: boolean; contextClosed: boolean;
  uploadBytes: number; idle: boolean; requestCount: number;
};
export type LifecycleRecord = {
  id: string; project: string; phase: BrowserPhase; sample: string | null;
  status: 'passed' | 'failed'; error: string | null; capability: unknown;
  delivery?: Delivery; sourceSha256?: string; uploadSha256?: string;
  browserVersion?: string; sourceRate?: number | null; recorderRate?: number | null;
  run: string; commit: string;
};
export const manifestHashes = {
  linux: 'ccf50b7ddaef5f9a0cddd58f87c4f08421902c630b2ca2a485bfebaae727f40c',
  win32: 'ed605fe13aacaf21d0aceb18127d6bccb0a1099f561aa0ecef95952975cae905',
};
export function projects(platform: string): string[] {
  if (platform === 'linux') return ['desktop-chromium', 'android-chromium', 'iphone-webkit'];
  if (platform === 'win32') return ['installed-edge'];
  throw new Error('Unsupported lifecycle platform');
}
export function expectedRecords(platform: string): string[] {
  return projects(platform).flatMap(project => [
    `${project}/initial`, ...sampleIds.map(id => `${project}/enabled/${id}`), `${project}/disabled`,
  ]);
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected response object');
  return value as Record<string, unknown>;
}
export function assertCapability(value: unknown, enabled: boolean): void {
  const body = object(value);
  assert.equal(body.ok, true);
  assert.equal(body.enabled, enabled);
  assert.equal(body.maxSeconds, 30);
  assert.equal(body.model, enabled ? 'sensevoice-small-q8' : null);
  assert.equal(body.provider, enabled ? 'sensevoice-gguf' : null);
  assert.equal(body.threads, enabled ? 2 : null);
  if (enabled) assert.equal(body.resourcePolicy, 'standard');
}
export function assertDelivery(row: Delivery): void {
  const body = object(row.body);
  assert.equal(row.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.text, 'string');
  const text = body.text as string;
  assert.ok(text.trim() && !text.includes('\0'), 'Empty or invalid real transcript');
  assert.ok(typeof body.elapsedMs === 'number' && Number.isFinite(body.elapsedMs) && body.elapsedMs >= 0);
  assert.equal(row.draft, 'Keep my draft');
  assert.equal(row.composer, `${row.draft}\n${text}`, 'Draft/API/composer mismatch');
  assert.equal(row.sends, 0, 'Unsolicited chat send');
  assert.equal(row.requestCount, 1, 'Expected exactly one real voice POST');
  assert.ok(Number.isInteger(row.uploadBytes) && row.uploadBytes > 44 && row.uploadBytes <= 960044);
  for (const key of ['sourceCompleted', 'tracksStopped', 'contextClosed', 'idle'] as const) {
    assert.equal(row[key], true, `Incomplete ${key}`);
  }
}
export function validateHost(value: unknown, run: string, commit: string): void {
  const host = object(value);
  assert.equal(host.run, run); assert.equal(host.commit, commit);
  assert.equal(host.status, 'passed');
  assert.ok(host.platform === 'linux' || host.platform === 'win32');
  assert.equal(object(host.identity).manifest, manifestHashes[host.platform]);
  assert.equal(object(host.identity).verifiedRoles, true);
  assert.equal(host.temporaryDirectoriesRestored, true);
  assert.ok(Array.isArray(host.phases));
  assert.deepEqual(host.phases.map(value => object(value).name), [...phases]);
  for (const phase of host.phases) assert.equal(object(phase).status, 'passed');
  assert.ok(Array.isArray(host.records));
  const expected = expectedRecords(host.platform);
  assert.deepEqual(host.records.map(value => object(value).id).sort(), expected.sort());
  for (const raw of host.records) {
    const row = object(raw);
    assert.equal(row.run, run); assert.equal(row.commit, commit); assert.equal(row.status, 'passed');
    assert.equal(row.error, null);
    assert.ok(projects(host.platform).includes(String(row.project)));
    assert.ok(['initial', 'enabled', 'disabled'].includes(String(row.phase)));
    assert.equal(row.id, `${row.project}/${row.phase}${row.phase === 'enabled' ? `/${row.sample}` : ''}`);
    assertCapability(row.capability, row.phase === 'enabled');
    if (row.phase === 'enabled') {
      assert.ok(sampleIds.includes(row.sample as typeof sampleIds[number]));
      assert.match(String(row.sourceSha256), /^[0-9a-f]{64}$/);
      assert.match(String(row.uploadSha256), /^[0-9a-f]{64}$/);
      assertDelivery(row.delivery as Delivery);
    } else assert.equal(row.sample, null);
  }
}
