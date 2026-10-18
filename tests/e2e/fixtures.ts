import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test as base, type BrowserContext } from '@playwright/test';
import type { CatalogEntry, CatalogManifest, ModelManifest, PlantRecord } from '../../src/assets/manifest';

// Test inputs stay outside the deployed bundle. An isolated worktree can read
// the coordinator's prepared assets without copying them into its public tree.
const publicRoot = resolve(process.env.PLANT_FRIENDS_TEST_PUBLIC ?? 'public');
export type CatalogData = {
  manifest: CatalogManifest; index: CatalogEntry[]; zero: PlantRecord; missing: PlantRecord; provenance: PlantRecord;
  manifestPath: string; model: ModelManifest; modelManifestPath: string;
};
type PlantPhotos = { first: Buffer; second: Buffer };
type InstalledCatalog = { context: BrowserContext; catalogGets: Record<string, number>; seedGets: Record<string, number>; modelUrls: Set<string> };

export async function readPhotoFixtures(): Promise<PlantPhotos> {
  const fixture = JSON.parse(await readFile(resolve(publicRoot, 'fixtures/photos.json'), 'utf8')) as { photos: { file: string; sha256: string }[] };
  expect(fixture.photos.length, 'Prepare the pinned licensed photo fixtures before UI acceptance.').toBeGreaterThanOrEqual(2);
  const photos = await Promise.all(fixture.photos.slice(0, 2).map(async photo => {
    expect(photo.file).toMatch(/^[\w.-]+$/);
    const bytes = await readFile(resolve(publicRoot, 'fixtures/photos', photo.file));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(photo.sha256);
    return bytes;
  }));
  return { first: photos[0], second: photos[1] };
}

// These worker-scoped source expectations also serve fresh-context offline/setup
// tests; reading the real files does not make extra HTTP copies of the catalog.
export const sourceTest = base.extend<{}, { catalogData: CatalogData; plantPhotos: PlantPhotos }>({
  plantPhotos: [async ({}, use) => { await use(await readPhotoFixtures()); }, { scope: 'worker' }],
  catalogData: [async ({}, use) => {
    const pointer = JSON.parse(await readFile(resolve(publicRoot, 'catalog.json'), 'utf8')) as { url: string };
    const manifestPath = resolve(publicRoot, pointer.url);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CatalogManifest;
    expect(manifest.kind).toBe('pfaf');
    const indexFile = manifest.files.find(file => file.url === manifest.indexFile)!;
    expect(indexFile).toBeTruthy();
    const bytes = await readFile(resolve(dirname(manifestPath), indexFile.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(indexFile.sha256);
    const index = JSON.parse(bytes.toString()) as CatalogEntry[];
    expect(index).toHaveLength(manifest.taxonCount);
    const ratings = ['edibility_rating', 'medicinal_rating', 'other_uses_rating'];
    let zero: PlantRecord | undefined, missing: PlantRecord | undefined, provenance: PlantRecord | undefined;
    for (const file of manifest.files) {
      if (file.url === manifest.indexFile) continue;
      const bytes = await readFile(resolve(dirname(manifestPath), file.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
      const records = Object.values(JSON.parse(bytes.toString()) as Record<string, PlantRecord>);
      zero ??= records.find(record => ratings.some(key => record.fields[key] === 0));
      missing ??= records.find(record => ratings.some(key => record.fields[key] === null));
      provenance ??= records.find(record => !record.fields.details_scraped_at &&
        ['edible_uses', 'medicinal_uses', 'other_uses'].some(key => /\[[^\]]+\]/.test(String(record.fields[key] ?? ''))));
      if (zero && missing && provenance) break;
    }
    expect(zero, 'The actual catalog needs a zero-rating case.').toBeTruthy();
    expect(missing, 'The actual catalog needs a missing-rating case.').toBeTruthy();
    expect(provenance, 'The actual catalog needs a reference-marker/unknown-freshness case.').toBeTruthy();
    const modelPointer = JSON.parse(await readFile(resolve(publicRoot, 'model.json'), 'utf8')) as { url: string };
    const modelManifestPath = resolve(publicRoot, modelPointer.url);
    const model = JSON.parse(await readFile(modelManifestPath, 'utf8')) as ModelManifest;
    await use({ manifest, index, zero: zero!, missing: missing!, provenance: provenance!, manifestPath, model, modelManifestPath });
  }, { scope: 'worker' }],
});

// Interaction-only tests retain a real installation for one worker. No saved
// receipt/cache entry is fabricated and no browser storageState is substituted.
export const test = sourceTest.extend<{}, { installedCatalog: InstalledCatalog }>({
  installedCatalog: [async ({ browser, catalogData }, use, workerInfo) => {
    const baseURL = workerInfo.project.use.baseURL;
    if (!baseURL) throw new Error('Cached interaction tests require a production-preview baseURL.');
    const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    const catalogManifestUrl = new URL(catalogData.manifestPath.slice(publicRoot.length + 1), baseURL);
    const payloadUrls = new Set(catalogData.manifest.files.map(file => new URL(file.url, catalogManifestUrl).href));
    const modelManifestUrl = new URL(catalogData.modelManifestPath.slice(publicRoot.length + 1), baseURL);
    const modelUrls = new Set(catalogData.model.files.map(file => new URL(file.url, modelManifestUrl).href));
    const catalogGets: Record<string, number> = {};
    context.on('request', request => {
      if (request.method() === 'GET' && payloadUrls.has(request.url())) catalogGets[request.url()] = (catalogGets[request.url()] ?? 0) + 1;
    });
    await context.route(url => /\.onnx$/i.test(url.pathname) || modelUrls.has(url.href), route => route.abort('blockedbyclient'));
    try {
      const primer = await context.newPage();
      await primer.goto('/?diagnostics=1');
      await primer.waitForFunction(() => Boolean(window.plantFriends));
      const receipt = await primer.evaluate(() => window.plantFriends.install('pfaf'));
      expect(receipt.id).toBe(catalogData.manifest.id);
      expect(receipt.bytes).toBe(catalogData.manifest.files.reduce((sum, file) => sum + file.bytes, 0));
      await primer.close();
      expect(Object.keys(catalogGets)).toHaveLength(payloadUrls.size);
      expect(Object.values(catalogGets).every(count => count === 1)).toBe(true);
      await use({ context, catalogGets, seedGets: { ...catalogGets }, modelUrls });
    } finally { await context.close(); }
  }, { scope: 'worker' }],
  context: async ({ installedCatalog }, use, testInfo) => {
    const { context, catalogGets, seedGets, modelUrls } = installedCatalog;
    const before = { ...catalogGets };
    try { await use(context); }
    finally {
      // Close pages FIRST: removing a held model route while its page is alive
      // could release the pending encoder request to the network.
      await Promise.all(context.pages().map(page => page.close()));
      await context.unrouteAll({ behavior: 'ignoreErrors' });
      await context.route(url => /\.onnx$/i.test(url.pathname) || modelUrls.has(url.href), route => route.abort('blockedbyclient'));
      await context.setOffline(false);
      await context.clearPermissions();
      await context.clearCookies();
      const path = testInfo.outputPath('catalog-cache-reuse.json');
      await writeFile(path, JSON.stringify({ worker: testInfo.workerIndex, seedGets, before, after: catalogGets, openPagesAfterTest: context.pages().length }, null, 2));
      await testInfo.attach('catalog-cache-reuse', { path, contentType: 'application/json' });
      expect(catalogGets, 'Interaction tests must read the installed catalog rather than downloading its payload again.').toEqual(before);
    }
  },
  page: async ({ context }, use) => {
    // Keep init scripts page-scoped; only the installed catalog outlives a test.
    const page = await context.newPage();
    try { await use(page); }
    finally { await page.close(); }
  },
});

export { expect };
