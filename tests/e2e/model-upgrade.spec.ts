import { expect, test as base, type Page, type Route } from '@playwright/test';
import { asset, catalog, CONTENT, model } from '../assets/fixtures';
import type {} from '../../src/dev/api';

// Fabricated, non-runnable model bytes; the actual App, automatic setup,
// integrity verification, HTTP Range chunks, CacheStorage and IDB are exercised.
// Run against the Vite development server, never a real model or inference.
type Upgrade = {
  runtime: Route[];
  runtimeBody: Buffer;
  weightRanges: string[];
  photos: number;
};
const test = base.extend<{ upgrade: Upgrade }>({
  upgrade: [async ({ page, context, baseURL }, use) => {
    if (!baseURL) throw new Error('The model-upgrade fixture requires the development-server baseURL.');
    const origin = new URL(baseURL).origin;
    const pfaf = catalog();
    const previous = model(); previous.id = 'previous-model';
    previous.model.file = asset('/tests/assets/downloads/shared-weights.onnx', new Uint8Array(8 * 1024 * 1024 + 257).fill(37));
    previous.files[0] = previous.model.file;
    const next = structuredClone(previous); next.id = 'updated-model';
    const oldRuntime = previous.runtime.files[0];
    const previousRuntimeBody = Buffer.from(CONTENT.get(oldRuntime.url)!);
    const runtimeBody = Buffer.from('updated fabricated runtime; never executed');
    const nextRuntime = asset(oldRuntime.url, runtimeBody);
    next.runtime.files[0] = nextRuntime;
    next.files = next.files.map(file => file.url === nextRuntime.url ? nextRuntime : file);
    const catalogUrl = new URL('/packs/pfaf/test/manifest.json', origin);
    const previousUrl = new URL('/packs/bioclip2/previous/manifest.json', origin);
    const nextUrl = new URL('/packs/bioclip2/updated/manifest.json', origin);
    const runtimeUrl = new URL(oldRuntime.url, previousUrl).href;
    const weightsUrl = new URL(previous.model.file.url, previousUrl).href;
    const payloads = new Map<string, Buffer>();
    for (const [manifest, url] of [[pfaf, catalogUrl], [previous, previousUrl], [next, nextUrl]] as const)
      for (const file of manifest.files) payloads.set(new URL(file.url, url).href, Buffer.from(CONTENT.get(file.url)!));
    let advertiseUpdate = false;
    const state: Upgrade = { runtime: [], runtimeBody, weightRanges: [], photos: 0 };
    const json = new Map([
      [catalogUrl.href, JSON.stringify(pfaf)], [previousUrl.href, JSON.stringify(previous)], [nextUrl.href, JSON.stringify(next)],
    ]);
    // Fail closed: no unrecognized encoder can escape this bounded fixture.
    await context.route('**/*.onnx*', route => route.abort('blockedbyclient'));
    await context.route(url => json.has(url.href) || payloads.has(url.href) ||
      ['/catalog.json', '/model.json', '/photos.json'].includes(url.pathname), async route => {
      const url = route.request().url(), path = new URL(url).pathname;
      if (path === '/catalog.json') return route.fulfill({ json: { url: catalogUrl.pathname } });
      if (path === '/model.json') return route.fulfill({ json: { url: advertiseUpdate ? nextUrl.pathname : previousUrl.pathname } });
      if (path === '/photos.json') { state.photos++; return route.fulfill({ status: 500, body: 'No reference photos in this upgrade fixture' }); }
      if (url === runtimeUrl) {
        if (advertiseUpdate) { state.runtime.push(route); return; }
        return route.fulfill({ body: previousRuntimeBody });
      }
      if (url === weightsUrl) {
        const range = route.request().headers().range ?? '';
        state.weightRanges.push(range);
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!match) return route.fulfill({ status: 400, body: 'Expected a bounded byte range' });
        const [, start, end] = match, bytes = payloads.get(url)!;
        return route.fulfill({ status: 206, body: bytes.subarray(Number(start), Number(end) + 1), headers: {
          'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(Number(end) - Number(start) + 1),
        } });
      }
      await route.fulfill({ body: json.get(url) ?? payloads.get(url)! });
    });
    await page.goto('/?diagnostics=1');
    await page.waitForFunction(() => Boolean(window.plantFriends));
    await page.evaluate(async () => { await window.plantFriends.install('pfaf'); await window.plantFriends.install('bioclip2'); });
    expect(state.weightRanges).toEqual(['bytes=0-8388607', 'bytes=8388608-8388864']);
    advertiseUpdate = true;
    await use(state);
  }, { auto: true }],
});
test.use({ serviceWorkers: 'block' });

async function savedState(page: Page) {
  return page.evaluate(async () => {
    const modulePath = '/src/assets/storage.ts';
    const storage = await import(/* @vite-ignore */ modulePath) as typeof import('../../src/assets/storage');
    const receipt = await storage.installedPack('bioclip2');
    const cache = await caches.open(storage.ASSET_CACHE);
    return { receipt, chunks: (await cache.keys()).filter(request => request.url.includes('__plant-friends-chunk__')).map(request => request.url).sort() };
  });
}

test('a failed automatic model upgrade keeps the working receipt/catalog, then reuses verified weight chunks without reinstall loops', async ({ page, upgrade }) => {
  const saved = await savedState(page);
  expect(saved.receipt?.manifest.id).toBe('previous-model');
  expect(saved.chunks).toHaveLength(2);
  await page.goto('/');
  await expect.poll(() => upgrade.runtime.length).toBe(1);
  await expect(page.getByRole('table')).toBeVisible();
  expect(upgrade.photos).toBe(0);
  expect(await savedState(page)).toEqual(saved);
  await upgrade.runtime[0].fulfill({ status: 500, body: 'deliberate upgrade failure' });
  await expect(page.locator('#setup-status')).toContainText('HTTP 500');
  expect(await savedState(page)).toEqual(saved);
  await page.waitForTimeout(1_250);
  expect(upgrade.runtime).toHaveLength(1);
  expect(upgrade.photos).toBe(0);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => upgrade.runtime.length).toBe(2);
  expect(await savedState(page)).toEqual(saved);
  await upgrade.runtime[1].fulfill({ body: upgrade.runtimeBody });
  await expect.poll(async () => (await savedState(page)).receipt?.manifest.id).toBe('updated-model');
  await expect.poll(() => upgrade.photos).toBe(1);
  const activated = await savedState(page);
  expect(activated.chunks).toEqual(saved.chunks);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.locator('.diagnostics dt').filter({ hasText: /^Offline setup$/ }).locator('+ dd')).toHaveText('idle');
  await page.reload();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.locator('.diagnostics')).toContainText('updated-model');
  await expect(page.locator('.diagnostics dt').filter({ hasText: /^Offline setup$/ }).locator('+ dd')).toHaveText('idle');
  expect((await savedState(page)).receipt?.installedAt).toBe(activated.receipt?.installedAt);
  expect(upgrade.runtime).toHaveLength(2);
  expect(upgrade.weightRanges).toEqual(['bytes=0-8388607', 'bytes=8388608-8388864']);
});

test('transient upgrade retries stay bounded with the old model intact, then reconnect resumes using saved weights', async ({ page, context, upgrade }) => {
  const saved = await savedState(page);
  await page.goto('/');
  for (let attempt = 1; attempt <= 4; attempt++) {
    await expect.poll(() => upgrade.runtime.length, { timeout: 10_000 }).toBe(attempt);
    expect(await savedState(page)).toEqual(saved);
    await upgrade.runtime[attempt - 1].abort('failed');
  }
  await expect(page.locator('#setup-status')).toContainText('return to this page');
  await page.waitForTimeout(750);
  expect(upgrade.runtime).toHaveLength(4);
  expect(upgrade.photos).toBe(0);
  expect(await savedState(page)).toEqual(saved);
  await context.setOffline(true);
  await context.setOffline(false);
  await expect.poll(() => upgrade.runtime.length).toBe(5);
  await upgrade.runtime[4].fulfill({ body: upgrade.runtimeBody });
  await expect.poll(async () => (await savedState(page)).receipt?.manifest.id).toBe('updated-model');
  expect((await savedState(page)).chunks).toEqual(saved.chunks);
  expect(upgrade.weightRanges).toEqual(['bytes=0-8388607', 'bytes=8388608-8388864']);
});
