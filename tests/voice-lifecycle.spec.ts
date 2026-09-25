import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { assertCapability, assertDelivery, sampleIds, type BrowserPhase, type LifecycleRecord } from '../scripts/voice/lifecycle-contract';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';
import { armBrowserCapture, installBrowserCapture, playBrowserCapture, snapshotBrowserCapture } from './helpers/voiceBrowserCapture';

const phase = process.env.LIFECYCLE_PHASE;
if (phase && !['initial', 'enabled', 'disabled'].includes(phase)) throw new Error('Invalid lifecycle phase');
const activePhase = (phase || 'initial') as BrowserPhase;
const selected: (string | null)[] = activePhase === 'enabled' ? [...sampleIds] : [null];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

for (const sid of selected) {
  test(`installed lifecycle ${activePhase}${sid ? ` ${sid}` : ''}`, async ({ page, browser }, info) => {
    test.skip(!phase, 'Requires the Actions installed lifecycle runner');
    const id = `${info.project.name}/${activePhase}${sid ? `/${sid}` : ''}`;
    const directory = `lifecycle-evidence/records/${id}`;
    mkdirSync(directory, { recursive: true });
    const row: LifecycleRecord = {
      id, project: info.project.name, phase: activePhase, sample: sid,
      run: process.env.GITHUB_RUN_ID!, commit: process.env.GITHUB_SHA!,
      status: 'failed', error: 'not_completed', capability: null, browserVersion: browser.version(),
    };
    try {
      const fixture = await installMobileChatFixture(page);
      if (sid) await installBrowserCapture(page);
      const observedCapability = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/voice' && response.request().method() === 'GET');
      await loginMobileFixture(page);
      const capabilityResponse = await observedCapability;
      expect(capabilityResponse.status()).toBe(200);
      row.capability = await capabilityResponse.json();
      assertCapability(row.capability, activePhase === 'enabled');
      const start = page.getByRole('button', { name: 'Start voice input', exact: true });
      if (!sid) {
        await expect(start).toHaveCount(0);
      } else {
        await expect(start).toBeEnabled();
        const samples: { id: string; duration: number; audio_sha256: string }[] =
          JSON.parse(readFileSync('lifecycle-inputs/samples.json', 'utf8'));
        const sample = samples.find(value => value.id === sid);
        if (!sample) throw new Error('Missing selected source');
        const audio = readFileSync(`lifecycle-inputs/speech/${sid}.wav`);
        expect(sha(audio)).toBe(sample.audio_sha256);
        row.sourceSha256 = sample.audio_sha256;
        let requestCount = 0;
        page.on('request', request => {
          if (new URL(request.url()).pathname === '/api/voice' && request.method() === 'POST') {
            expect(new URL(request.url()).origin).toBe(new URL(process.env.PLAYWRIGHT_BASE_URL!).origin);
            requestCount++;
          }
        });
        await armBrowserCapture(page, audio.toString('base64'));
        const draft = 'Keep my draft';
        const input = page.locator('textarea.composerTextarea');
        await input.fill(draft);
        await start.click();
        const stop = page.getByRole('button', { name: 'Stop recording', exact: true });
        await expect(stop).toBeVisible();
        await playBrowserCapture(page);
        await page.waitForTimeout(sample.duration * 1000 + 100);
        const responsePending = page.waitForResponse(response =>
          new URL(response.url()).pathname === '/api/voice' && response.request().method() === 'POST',
        { timeout: 135000 });
        await stop.click();
        const response = await responsePending;
        const body: unknown = await response.json();
        row.delivery = {
          status: response.status(), body, draft, composer: await input.inputValue(),
          sends: fixture.acpRequests.filter(value => value.action === 'send').length, requestCount,
          sourceCompleted: false, tracksStopped: false, contextClosed: false, uploadBytes: 0, idle: false,
        };
        await expect(start).toBeEnabled({ timeout: 10000 });
        await expect.poll(async () => (await snapshotBrowserCapture(page)).capture.contextClosed).toBe(true);
        if (body && typeof body === 'object' && 'text' in body && typeof body.text === 'string') {
          await expect(input).toHaveValue(`${draft}\n${body.text}`);
        }
        const snapshot = await snapshotBrowserCapture(page, true);
        const upload = snapshot.uploadBase64 ? Buffer.from(snapshot.uploadBase64, 'base64') : Buffer.alloc(0);
        row.uploadSha256 = sha(upload);
        row.sourceRate = snapshot.capture.sourceRate;
        row.recorderRate = snapshot.capture.recorderRate;
        row.delivery = {
          status: response.status(), body, draft, composer: await input.inputValue(),
          sends: fixture.acpRequests.filter(value => value.action === 'send').length, requestCount,
          sourceCompleted: snapshot.capture.sourceCompleted, tracksStopped: snapshot.capture.tracksStopped,
          contextClosed: snapshot.capture.contextClosed, uploadBytes: upload.length, idle: await start.isEnabled(),
        };
        expect(snapshot.observerError).toBeNull();
        expect(snapshot.fetchFailure).toBeNull();
        assertDelivery(row.delivery);
      }
      await page.screenshot({ path: `${directory}/milestone.png`, animations: 'disabled' });
      row.status = 'passed'; row.error = null;
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      if (sid) {
        try {
          const snapshot = await snapshotBrowserCapture(page, true);
          if (row.delivery) {
            row.delivery.composer = await page.locator('textarea.composerTextarea').inputValue();
            Object.assign(row.delivery, { sourceCompleted: snapshot.capture.sourceCompleted,
              tracksStopped: snapshot.capture.tracksStopped, contextClosed: snapshot.capture.contextClosed });
          }
        } catch (captureError) {
          row.error += `; evidence snapshot failed: ${captureError instanceof Error ? captureError.message : String(captureError)}`;
        }
      }
      throw error;
    } finally {
      writeFileSync(`${directory}/record.json`, JSON.stringify(row, null, 2));
    }
  });
}
