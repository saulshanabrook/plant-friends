import { expect, test, type Route } from '@playwright/test';
import type { ModelManifest } from '../../src/assets/manifest';

// Actual catalog and metadata, deliberate transport failures; no model substitutes
// or inference claims. Separate catalog/PWA cases exercise the real service worker.
test.use({ serviceWorkers: 'block' });
let encoder: string;
test.beforeEach(async ({ context, request }) => {
  await context.route('**/*.onnx*', route => route.abort('blockedbyclient'));
  const pointer = await request.get('/model.json');
  const manifestResponse = await request.get((await pointer.json()).url);
  const manifest = await manifestResponse.json() as ModelManifest;
  encoder = new URL(manifest.model.file.url, manifestResponse.url()).href;
});

test('automatic catalog-before-model setup ignores legacy pause settings and resumes in a fresh page', async ({ page, context }) => {
  // Obsolete settings must not trap an upgraded installation behind absent controls.
  await page.addInitScript(() => { localStorage.setItem('plant-friends.offline-setup.v1', JSON.stringify({ paused: true, deleted: ['pfaf', 'bioclip2'], blocked: ['pfaf', 'bioclip2'] })); Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }); });
  let attempts = 0;
  await context.route(encoder, async route => { attempts++; await route.abort('failed'); });
  await page.goto('/');
  await expect(page.getByRole('table')).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => attempts).toBe(1);
  await expect(page.locator('#setup-status button')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect.poll(() => attempts).toBeGreaterThanOrEqual(2);
  await expect(reopened.getByRole('table')).toBeVisible();
});

test('transient network retries are delayed and bounded, then reconnect resumes automatically', async ({ page, context }) => {
  let attempts = 0;
  await context.route(encoder, async route => { attempts++; await route.abort('failed'); });
  await page.goto('/');
  await expect.poll(() => attempts, { timeout: 25_000 }).toBe(4);
  await expect(page.locator('#setup-status')).toContainText(/return to this page/i);
  await page.waitForTimeout(750);
  expect(attempts).toBe(4);
  await context.setOffline(true);
  await context.setOffline(false);
  await expect.poll(() => attempts).toBe(5);
});

test('returning to a visible page replaces a suspended request without manual controls', async ({ page, context }) => {
  let attempts = 0, stalled: Route | undefined;
  await context.route(encoder, async route => {
    attempts++;
    if (attempts === 1) stalled = route;
    else await route.fulfill({ status: 500, body: 'deliberate permanent test failure' });
  });
  await page.goto('/');
  await expect.poll(() => Boolean(stalled)).toBe(true);
  // Synthetic visibility event is lifecycle coverage, not physical screen-lock evidence.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => attempts).toBe(2);
  await stalled!.abort().catch(() => undefined);
  await expect(page.locator('#setup-status')).toContainText(/HTTP 500/);
});

test('permanent failures wait for a later lifecycle or reload rather than persisting a hidden block', async ({ page, context }) => {
  let attempts = 0;
  await context.route(encoder, async route => { attempts++; await route.fulfill({ status: 500, body: 'deliberate server failure' }); });
  await page.goto('/');
  await expect(page.locator('#setup-status')).toContainText('HTTP 500');
  expect(attempts).toBe(1);
  await page.waitForTimeout(1_250);
  expect(attempts).toBe(1);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => attempts).toBe(2);
  await page.reload();
  await expect.poll(() => attempts).toBe(3);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('a stale catalog-index rejection cannot clear entries loaded by a newer setup generation', async ({ page, context }) => {
  await context.route(encoder, route => route.fulfill({ status: 500, body: 'deliberate model failure' }));
  await page.goto('/?diagnostics=1');
  await page.waitForFunction(() => Boolean(window.plantFriends));
  await page.evaluate(() => window.plantFriends.install('pfaf'));
  await page.addInitScript(() => {
    const json = Response.prototype.json;
    let held = false;
    Response.prototype.json = async function () {
      const value = await json.call(this);
      if (!held && Array.isArray(value) && value[0]?.detailFile && value[0]?.scientificName) {
        held = true;
        return new Promise((_resolve, reject) => Object.defineProperty(window, '__rejectStaleIndex', { configurable: true, value: () => reject(new Error('deliberate stale index failure')) }));
      }
      return value;
    };
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as Window & { __rejectStaleIndex?: () => void }).__rejectStaleIndex));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('table')).toBeVisible();
  await page.evaluate(() => (window as Window & { __rejectStaleIndex?: () => void }).__rejectStaleIndex!());
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Plant catalog' })).toContainText('8,796');
});

test('a model retry preserves family, minimum-rating filters and pagination for the unchanged catalog', async ({ page, context }) => {
  let attempts = 0, stalled: Route | undefined;
  await context.route(encoder, async route => {
    attempts++;
    if (attempts === 1) stalled = route;
    else await route.fulfill({ status: 500, body: 'deliberate server failure' });
  });
  await page.goto('/');
  await expect.poll(() => Boolean(stalled)).toBe(true);
  const family = page.getByRole('combobox', { name: 'Family', exact: true });
  const minimum = page.getByRole('combobox', { name: 'Minimum edibility', exact: true });
  await expect(family).toBeEnabled();
  await family.selectOption('Pinaceae');
  await minimum.selectOption('0');
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).selectOption('25');
  const pages = page.getByRole('navigation', { name: 'Plant table pages', exact: true });
  await pages.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(pages).toContainText('Page 2 of');
  await stalled!.abort('failed');
  await expect.poll(() => attempts).toBe(2);
  await expect(family).toBeEnabled();
  await expect(family).toHaveValue('Pinaceae');
  await expect(minimum).toHaveValue('0');
  await expect(pages).toContainText('Page 2 of');
});

test('catalog install keeps one downloading label across per-file checks while its byte progress advances', async ({ page, context, request }, testInfo) => {
  const pointer = await request.get('/catalog.json');
  const response = await request.get((await pointer.json()).url);
  const catalog = await response.json() as { files: { url: string; bytes: number }[] };
  const files = catalog.files.slice(0, 3);
  expect(files).toHaveLength(3);
  const urls = files.map(file => new URL(file.url, response.url()).href);
  const held = new Map<string, Route>();
  for (const url of urls) await context.route(url, route => { held.set(url, route); });
  await page.addInitScript(() => {
    const samples: { text: string; value: number; max: number }[] = [];
    Object.defineProperty(window, '__downloadStatusSamples', { value: samples });
    new MutationObserver(() => {
      const status = document.querySelector('#setup-status');
      const bar = status?.querySelector('progress');
      if (!(bar instanceof HTMLProgressElement)) return;
      const sample = { text: status!.querySelector('p')?.textContent ?? '', value: bar.value, max: bar.max };
      const previous = samples.at(-1);
      if (!previous || previous.text !== sample.text || previous.value !== sample.value) samples.push(sample);
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['value'] });
  });
  await page.goto('/');
  await expect.poll(() => held.has(urls[0])).toBe(true);
  const bar = page.getByRole('progressbar', { name: 'Offline data download', exact: true });
  await expect(bar).toHaveAttribute('value', '0');
  await held.get(urls[0])!.continue();
  await expect.poll(() => held.has(urls[1])).toBe(true);
  await expect.poll(() => bar.evaluate(bar => (bar as HTMLProgressElement).value)).toBe(files[0].bytes);
  await held.get(urls[1])!.continue();
  await expect.poll(() => held.has(urls[2])).toBe(true);
  await expect.poll(() => bar.evaluate(bar => (bar as HTMLProgressElement).value)).toBe(files[0].bytes + files[1].bytes);
  const samples = await page.evaluate(() => (window as Window & { __downloadStatusSamples?: { text: string; value: number; max: number }[] }).__downloadStatusSamples!);
  // End this bounded real install after two files; never reach model/photo downloads.
  await held.get(urls[2])!.fulfill({ status: 500, body: 'deliberate end of catalog progress fixture' });
  await expect(page.locator('#setup-status')).toContainText('HTTP 500');
  await testInfo.attach('catalog-status-history', { body: JSON.stringify({ received: files[0].bytes + files[1].bytes, samples }, null, 2), contentType: 'application/json' });
  expect(samples.length).toBeGreaterThan(2);
  expect(samples.some(sample => sample.value > 0)).toBe(true);
  expect(samples.every(sample => sample.text.startsWith('Downloading plant data… ')), JSON.stringify(samples)).toBe(true);
});
