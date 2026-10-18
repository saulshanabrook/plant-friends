import { expect, test } from '@playwright/test';
import type {} from '../assets/browser';
import type { CatalogManifest } from '../../src/assets/manifest';
import { asset, catalog, model, CONTENT } from '../assets/fixtures';

// Real browser Cache API/IDB tests against tiny fabricated text files. They are
// separate from production offline inference and do not prove model feasibility.
let files: Record<string, string | Buffer>;
let requests: string[];
test.beforeEach(async ({ page }) => {
  files = {};
  requests = [];
  await page.route(/\/(tests\/assets\/downloads|runtime)\//, async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const body = files[path];
    await route.fulfill({ status: body === undefined ? 404 : 200, contentType: 'application/json', body: body ?? 'missing fixture' });
  });
  await page.goto('/tests/assets/browser.html');
  await page.waitForFunction(() => !!window.assetHarness);
});

test('semantic catalog/model activation rejects correctly hashed malformed data before readiness', async ({ page }) => {
  const catalogPack = catalog();
  const modelPack = model();
  const manifestUrl = await page.evaluate(() => window.assetHarness.manifestUrl);
  for (const [url, bytes] of CONTENT) files[new URL(url, manifestUrl).pathname] = Buffer.from(bytes);
  const early = await page.evaluate(pack => window.assetHarness.install(pack), modelPack);
  expect(early).toMatchObject({ ok: false });
  expect(early.error).toContain('Install the matching PFAF catalog');
  expect(requests).toHaveLength(0);
  expect(await page.evaluate(pack => window.assetHarness.install(pack), catalogPack)).toEqual({ ok: true });
  expect(await page.evaluate(pack => window.assetHarness.install(pack), modelPack)).toEqual({ ok: true });
  const invalid = model(); invalid.id = 'invalid-vectors';
  const vectorBytes = CONTENT.get('vectors.f32')!.slice();
  new Float32Array(vectorBytes.buffer)[0] = NaN;
  invalid.vectors.file = asset('vectors.f32', vectorBytes);
  invalid.files = invalid.files.map(file => file.url === 'vectors.f32' ? invalid.vectors.file : file);
  files[new URL('vectors.f32', manifestUrl).pathname] = Buffer.from(vectorBytes);
  const result = await page.evaluate(pack => window.assetHarness.install(pack), invalid);
  expect(result).toMatchObject({ ok: false });
  expect(result.error).toContain('invalid values');
  expect(await page.evaluate(() => window.assetHarness.installedPack('bioclip2').then(pack => pack?.manifest.id))).toBe(modelPack.id);
  const invalidCatalog = catalog('invalid-details');
  invalidCatalog.files[1] = asset('details.json', '{}');
  files[new URL('details.json', manifestUrl).pathname] = '{}';
  const details = await page.evaluate(pack => window.assetHarness.install(pack), invalidCatalog);
  expect(details).toMatchObject({ ok: false });
  expect(details.error).toContain('detail file');
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id))).toBe(catalogPack.id);
});

test('actual Cache/IDB install, reuse, receipt reload and offline reads/deletion', async ({ page, context }) => {
  const fixture = await page.evaluate(() => window.assetHarness.catalog('working', 'offline fixture detail'));
  files = fixture.files;
  expect(await page.evaluate(pack => window.assetHarness.install(pack), fixture.manifest)).toEqual({ ok: true });
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id ?? null))).toBe('working');
  expect(requests).toHaveLength(2);
  expect(await page.evaluate(pack => window.assetHarness.install(pack), fixture.manifest)).toEqual({ ok: true });
  expect(requests).toHaveLength(2);
  await context.setOffline(true);
  expect(await page.evaluate(() => window.assetHarness.detail())).toBe('offline fixture detail');
  // Reload after network recovery to reinitialize the module, then verify the
  // persisted receipt/cache without any download after going offline again.
  await context.setOffline(false);
  await page.reload();
  await page.waitForFunction(() => !!window.assetHarness);
  await context.setOffline(true);
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id ?? null))).toBe('working');
  expect(await page.evaluate(() => window.assetHarness.detail())).toBe('offline fixture detail');
  await page.evaluate(() => window.assetHarness.deletePack('pfaf'));
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id ?? null))).toBeNull();
  expect(await page.evaluate(() => (async () => (await (await caches.open(window.assetHarness.ASSET_CACHE)).keys()).length)())).toBe(0);
});

test('cancel keeps completed files for retry and never activates an incomplete pack', async ({ page }) => {
  const fixture = await page.evaluate(() => window.assetHarness.catalog('retry', 'retry fixture detail'));
  files = fixture.files;
  const result = await page.evaluate(pack => window.assetHarness.install(pack, '/tests/assets/downloads/details.json'), fixture.manifest);
  expect(result).toMatchObject({ ok: false, name: 'AbortError' });
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id ?? null))).toBeNull();
  expect(await page.evaluate(() => (async () => (await (await caches.open(window.assetHarness.ASSET_CACHE)).keys()).length)())).toBe(1);
  expect(requests).toHaveLength(2);
  expect(await page.evaluate(pack => window.assetHarness.install(pack), fixture.manifest)).toEqual({ ok: true });
  expect(requests).toHaveLength(3);
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id ?? null))).toBe('retry');
});

test('same-URL corruption and incompatible upgrade preserve the previous active pack', async ({ page }) => {
  const previous = await page.evaluate(() => window.assetHarness.catalog('old', 'old working content'));
  files = previous.files;
  expect(await page.evaluate(pack => window.assetHarness.install(pack), previous.manifest)).toEqual({ ok: true });
  const replacement = await page.evaluate(() => window.assetHarness.catalog('new', 'new working content'));
  files = { ...replacement.files, '/tests/assets/downloads/details.json': 'bad download bytes!' };
  const corrupt = await page.evaluate(pack => window.assetHarness.install(pack), replacement.manifest);
  expect(corrupt).toMatchObject({ ok: false });
  expect(corrupt.error).toMatch(/Integrity|size changed/);
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id ?? null))).toBe('old');
  expect(await page.evaluate(() => window.assetHarness.detail())).toBe('old working content');
  const malformed = { ...replacement.manifest, files: [null] } as unknown as CatalogManifest;
  expect(await page.evaluate(pack => window.assetHarness.install(pack), malformed)).toMatchObject({ ok: false });
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id ?? null))).toBe('old');
  files = replacement.files;
  expect(await page.evaluate(pack => window.assetHarness.install(pack), replacement.manifest)).toEqual({ ok: true });
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id ?? null))).toBe('new');
  expect(await page.evaluate(() => window.assetHarness.detail())).toBe('new working content');
  expect(await page.evaluate(() => (async () => (await (await caches.open(window.assetHarness.ASSET_CACHE)).keys()).length)())).toBe(2);
});

test('eviction invalidates readiness and explicit reinstall restores it', async ({ page }) => {
  const fixture = await page.evaluate(() => window.assetHarness.catalog('evict', 'working fixture detail'));
  files = fixture.files;
  await page.evaluate(pack => window.assetHarness.install(pack), fixture.manifest);
  await page.evaluate(() => (async () => { const cache = await caches.open(window.assetHarness.ASSET_CACHE); await cache.delete((await cache.keys())[0]); })());
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id ?? null))).toBeNull();
  expect(await page.evaluate(pack => window.assetHarness.install(pack), fixture.manifest)).toEqual({ ok: true });
  expect(await page.evaluate(() => window.assetHarness.installedPack('pfaf').then(pack => pack?.manifest.id ?? null))).toBe('evict');
});
