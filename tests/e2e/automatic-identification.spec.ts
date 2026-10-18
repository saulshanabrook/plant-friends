import { createHash } from 'node:crypto';
import type { Route } from '@playwright/test';
import { catalog, model, CONTENT, INDEX } from '../assets/fixtures';
import { expect, sourceTest } from './fixtures';

// SIMULATED INFERENCE: tiny fabricated packs pass the real installer; only the
// Worker protocol is doubled. This proves App + real InferenceClient scheduling,
// cancellation and stale-reply handling, never model accuracy or GPU execution.
type WorkerControls = {
  commands: { type: string; worker: number; id?: number; name?: string }[];
  pending: { worker: { onmessage: ((event: { data: unknown }) => void) | null; terminated: boolean }; id: number; replied: boolean }[];
  loads: (() => void)[];
  holdLoads: boolean;
  failLoad: boolean;
  releaseLoads(): void;
  reply(index: number, choice?: number): void;
};
declare global { interface Window { autoIdWorker: WorkerControls; autoCameraStream?: MediaStream } }
const test = sourceTest.extend<{ delayedModel: boolean; simulated: { encoder: Route | null; encoderBytes: Buffer } }>({
  delayedModel: [false, { option: true }],
  simulated: [async ({ context, page, delayedModel }, use, testInfo) => {
    const origin = new URL(testInfo.project.use.baseURL!).origin;
    const pfaf = catalog(), bioclip = model();
    const catalogUrl = new URL('/packs/pfaf/test/manifest.json', origin);
    const modelUrl = new URL('/packs/bioclip2/test/manifest.json', origin);
    const payloads = new Map<string, Buffer>();
    for (const [manifest, url] of [[pfaf, catalogUrl], [bioclip, modelUrl]] as const)
      for (const file of manifest.files) payloads.set(new URL(file.url, url).href, Buffer.from(CONTENT.get(file.url)!));
    const encoderUrl = new URL(bioclip.model.file.url, modelUrl).href;
    const state = { encoder: null as Route | null, encoderBytes: payloads.get(encoderUrl)! };
    const album = Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'auto-ui', catalogId: pfaf.id,
      source: { repository: 'Fabricated UI test data', commit: 'a'.repeat(40), databaseSha256: 'b'.repeat(64) },
      images: {}, plants: Object.fromEntries(INDEX.map(entry => [entry.id, []])) }));
    const json = new Map([
      [new URL('/catalog.json', origin).href, JSON.stringify({ url: catalogUrl.pathname })],
      [new URL('/model.json', origin).href, JSON.stringify({ url: modelUrl.pathname })],
      [catalogUrl.href, JSON.stringify(pfaf)], [modelUrl.href, JSON.stringify(bioclip)],
      [new URL('/photos.json', origin).href, JSON.stringify({ url: 'photos/auto-ui/manifest.json', bytes: album.length, sha256: createHash('sha256').update(album).digest('hex') })],
      [new URL('/photos/auto-ui/manifest.json', origin).href, album.toString()],
    ]);
    await context.route(url => json.has(url.href) || payloads.has(url.href), async route => {
      const url = route.request().url();
      if (delayedModel && url === encoderUrl) { state.encoder = route; return; }
      const body = json.get(url) ?? payloads.get(url)!;
      await route.fulfill({ status: 200, contentType: json.has(url) || url.endsWith('.json') ? 'application/json' : 'application/octet-stream', body });
    });
    await page.addInitScript(() => {
      // Capability presence only. The double below never requests a GPU adapter.
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} });
      let workers = 0;
      window.autoIdWorker = {
        commands: [], pending: [], loads: [], holdLoads: false, failLoad: false,
        releaseLoads() { this.holdLoads = false; for (const release of this.loads.splice(0)) release(); },
        reply(index, choice = 0) {
          const request = this.pending[index];
          request.replied = true;
          if (!request.worker.terminated) request.worker.onmessage?.({ data: { type: 'result', id: request.id,
            result: { requestId: request.id, packId: 'fixture-model', catalogId: 'fixture-catalog', inputCount: 1,
              candidates: [{ taxonId: `taxon-${choice}`, similarity: 0.75 }], embedding: [],
              timings: { preprocessingMs: 1, inferenceMs: 1, rankingMs: 1, totalMs: 3 } } } });
        },
      };
      class ProtocolWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: ((event: { message: string }) => void) | null = null;
        terminated = false;
        number = ++workers;
        constructor(url: string | URL) {
          if (!String(url).includes('inference.worker')) throw new Error('Unexpected worker in automatic-ID UI fixture.');
        }
        postMessage(command: { type: string; id?: number; photo?: File }) {
          const control = window.autoIdWorker;
          control.commands.push({ type: command.type, worker: this.number, id: command.id, name: command.photo?.name ?? (command.photo ? 'Camera photo' : undefined) });
          if (command.type === 'load') {
            const deliver = () => {
              if (this.terminated) return;
              if (control.failLoad) {
                control.failLoad = false;
                this.onmessage?.({ data: { type: 'error', id: command.id, code: 'model-initialization', message: 'Simulated model initialization failure' } });
              } else this.onmessage?.({ data: { type: 'loaded', id: command.id, result: {
                secureContext: true, adapter: {}, features: [], limits: {}, runtimeVersion: '1.30.0', executionProvider: 'webgpu',
                initializationMs: 1, modelBytes: 11, packId: 'fixture-model', catalogId: 'fixture-catalog', backend: 'native-webgpu-asyncify', deviceFeatures: [],
              } } });
            };
            if (control.holdLoads) control.loads.push(deliver); else queueMicrotask(deliver);
          }
          if (command.type === 'identify') control.pending.push({ worker: this, id: command.id!, replied: false });
        }
        terminate() { this.terminated = true; }
      }
      Object.defineProperty(window, 'Worker', { configurable: true, value: ProtocolWorker });
    });
    await use(state);
  }, { auto: true }],
});
test.use({ serviceWorkers: 'block' });

test.describe('SIMULATED INFERENCE: automatic readiness', () => {
  test.use({ delayedModel: true });
  test('an upload waits for the actual tiny pack installation, then identifies once without a click', async ({ page, plantPhotos, simulated }) => {
    await page.goto('/');
    await expect.poll(() => Boolean(simulated.encoder)).toBe(true);
    await page.locator('input[type=file]').setInputFiles({ name: 'waiting.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.first });
    await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toBeVisible();
    await expect(page.getByText('Waiting for identification downloads…', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.autoIdWorker.commands.filter(c => c.type === 'load' || c.type === 'identify'))).toEqual([]);
    await expect(page.getByRole('button', { name: 'Identify this photo', exact: true })).toHaveCount(0);
    await simulated.encoder!.fulfill({ status: 200, body: simulated.encoderBytes });
    await expect.poll(() => page.evaluate(() => window.autoIdWorker.pending.length)).toBe(1);
    await page.evaluate(() => window.autoIdWorker.reply(0));
    await expect(page.locator('.candidate-list')).toContainText('Fixture 0');
    await page.getByRole('button', { name: 'Add app', exact: true }).click();
    await expect(page.locator('#install-help')).toBeVisible();
    expect(await page.evaluate(() => window.autoIdWorker.commands.filter(c => c.type === 'identify').length)).toBe(1);
  });
});

test('SIMULATED INFERENCE: replacement during initialization reuses one load and submits only the latest photo', async ({ page, plantPhotos }) => {
  await page.goto('/');
  await page.evaluate(() => { window.autoIdWorker.holdLoads = true; });
  await page.locator('input[type=file]').setInputFiles({ name: 'old.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.first });
  await expect.poll(() => page.evaluate(() => window.autoIdWorker.loads.length)).toBe(1);
  await page.locator('input[type=file]').setInputFiles({ name: 'latest.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.second });
  await expect(page.locator('.photo-label')).toContainText('latest.jpg');
  await page.evaluate(() => window.autoIdWorker.releaseLoads());
  await expect.poll(() => page.evaluate(() => window.autoIdWorker.pending.length)).toBe(1);
  expect(await page.evaluate(() => window.autoIdWorker.commands.filter(c => c.type === 'identify').map(c => c.name))).toEqual(['latest.jpg']);
  expect(await page.evaluate(() => window.autoIdWorker.commands.filter(c => c.type === 'load').length)).toBe(1);
  await page.evaluate(() => window.autoIdWorker.reply(0, 1));
  await expect(page.locator('.candidate-list')).toContainText('Fixture 1');
});

test('SIMULATED INFERENCE: offline replacement and reset cannot restore old matches', async ({ page, context, plantPhotos }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'old.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.first });
  await expect.poll(() => page.evaluate(() => window.autoIdWorker.pending.length)).toBe(1);
  await context.setOffline(true);
  await page.locator('input[type=file]').setInputFiles({ name: 'new.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.second });
  await expect.poll(() => page.evaluate(() => window.autoIdWorker.pending.length)).toBe(2);
  await page.evaluate(() => { window.autoIdWorker.reply(1, 2); window.autoIdWorker.reply(0, 0); });
  await expect(page.locator('.candidate-list')).toContainText('Fixture 2');
  await expect(page.locator('.candidate-list')).not.toContainText('Fixture 0');
  await page.locator('input[type=file]').setInputFiles({ name: 'reset-pending.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.first });
  await expect.poll(() => page.evaluate(() => window.autoIdWorker.pending.length)).toBe(3);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.evaluate(() => window.autoIdWorker.reply(2, 3));
  await expect(page.locator('.candidate-list')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toHaveCount(0);
  expect(await page.evaluate(() => window.autoIdWorker.pending.length)).toBe(3);
});

test('SIMULATED INFERENCE: cancel stays cancelled, and explicit retry identifies the current photo once', async ({ page, plantPhotos }) => {
  await page.goto('/');
  await page.evaluate(() => { window.autoIdWorker.holdLoads = true; });
  await page.locator('input[type=file]').setInputFiles({ name: 'cancelled.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.first });
  await expect.poll(() => page.evaluate(() => window.autoIdWorker.loads.length)).toBe(1);
  await page.getByRole('button', { name: 'Cancel identification', exact: true }).click();
  await page.evaluate(() => window.autoIdWorker.releaseLoads());
  await page.getByRole('button', { name: 'Add app', exact: true }).click();
  await expect(page.locator('#install-help')).toBeVisible();
  expect(await page.evaluate(() => window.autoIdWorker.pending.length)).toBe(0);
  await page.getByRole('button', { name: 'Retry identification', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.autoIdWorker.pending.length)).toBe(1);
  await page.evaluate(() => window.autoIdWorker.reply(0));
  await expect(page.locator('.candidate-list')).toContainText('Fixture 0');
});

test('SIMULATED INFERENCE: initialization errors wait for retry and recover without a new photo', async ({ page, plantPhotos }) => {
  await page.goto('/');
  await page.evaluate(() => { window.autoIdWorker.failLoad = true; });
  await page.locator('input[type=file]').setInputFiles({ name: 'retry.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.first });
  await expect(page.getByText('Simulated model initialization failure', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add app', exact: true }).click();
  await expect(page.locator('#install-help')).toBeVisible();
  expect(await page.evaluate(() => window.autoIdWorker.commands.filter(c => c.type === 'load').length)).toBe(1);
  await page.getByRole('button', { name: 'Retry identification', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.autoIdWorker.pending.length)).toBe(1);
  await page.evaluate(() => window.autoIdWorker.reply(0));
  await expect(page.locator('.candidate-list')).toContainText('Fixture 0');
});

test('SIMULATED CAMERA/INFERENCE: capturing a still automatically identifies it and stops camera tracks', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    canvas.getContext('2d')!.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(1);
    Object.defineProperty(window, 'autoCameraStream', { configurable: true, value: stream });
    return stream;
  } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Use camera', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate(video => video instanceof HTMLVideoElement ? video.videoWidth : 0)).toBe(320);
  await page.getByRole('button', { name: 'Capture still photo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.autoIdWorker.pending.length)).toBe(1);
  await expect(page.locator('video')).toHaveCount(0);
  expect(await page.evaluate(() => window.autoCameraStream!.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  await page.evaluate(() => window.autoIdWorker.reply(0, 3));
  await expect(page.locator('.candidate-list')).toContainText('Fixture 3');
});
