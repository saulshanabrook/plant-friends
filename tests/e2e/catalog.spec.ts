import { expect, test as base } from '@playwright/test';
import type { CatalogEntry, CatalogManifest, ModelManifest, PlantRecord } from '../../src/assets/manifest';

type CatalogData = { manifest: CatalogManifest; index: CatalogEntry[]; zero: PlantRecord; missing: PlantRecord; provenance: PlantRecord };
const ratings = ['edibility_rating', 'medicinal_rating', 'other_uses_rating'] as const;
const test = base.extend<{ catalogData: CatalogData }>({
  catalogData: async ({ request }, use) => {
    const pointer = await request.get('/catalog.json');
    expect(pointer.ok(), 'Export the real PFAF catalog before UI acceptance.').toBe(true);
    expect(pointer.headers()['content-type']).toContain('application/json');
    const { url } = await pointer.json() as { url: string };
    const manifestResponse = await request.get(url);
    expect(manifestResponse.ok()).toBe(true);
    const manifest = await manifestResponse.json() as CatalogManifest;
    expect(manifest.kind).toBe('pfaf');
    const indexResponse = await request.get(new URL(manifest.indexFile, manifestResponse.url()).href);
    expect(indexResponse.ok()).toBe(true);
    const index = await indexResponse.json() as CatalogEntry[];
    expect(index).toHaveLength(manifest.taxonCount);
    let zero: PlantRecord | undefined, missing: PlantRecord | undefined, provenance: PlantRecord | undefined;
    for (const file of manifest.files) {
      if (file.url === manifest.indexFile) continue;
      const response = await request.get(new URL(file.url, manifestResponse.url()).href);
      expect(response.ok()).toBe(true);
      const records = Object.values(await response.json() as Record<string, PlantRecord>);
      zero ??= records.find(record => ratings.some(key => record.fields[key] === 0));
      missing ??= records.find(record => ratings.some(key => record.fields[key] === null));
      provenance ??= records.find(record => !record.fields.details_scraped_at &&
        ['edible_uses', 'medicinal_uses', 'other_uses'].some(key => /\[[^\]]+\]/.test(String(record.fields[key] ?? ''))));
      if (zero && missing && provenance) break;
    }
    expect(zero, 'The real export must provide a zero-rating acceptance case.').toBeTruthy();
    expect(missing, 'The real export must provide a missing-rating acceptance case.').toBeTruthy();
    expect(provenance, 'The real export must provide unknown freshness and recorded reference markers.').toBeTruthy();
    await use({ manifest, index, zero: zero!, missing: missing!, provenance: provenance! });
  },
});

test.setTimeout(120_000);

test('real PFAF search and source details work after an offline reload, without WebGPU or a model', async ({ page, context, catalogData }, testInfo) => {
  // Remove capability only; catalog responses, installation, and detail reads use the actual product APIs.
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => undefined }));
  const dedicatedWorkers: string[] = [];
  page.on('worker', worker => dedicatedWorkers.push(worker.url()));
  await page.goto('/');
  await page.getByRole('button', { name: 'Offline setup', exact: true }).click();
  const catalogCard = page.locator('.pack-card').filter({ has: page.getByRole('heading', { name: 'PFAF plant catalog', exact: true }) });
  await expect(catalogCard).toContainText(`${catalogData.manifest.taxonCount.toLocaleString()} catalog records`);
  await catalogCard.getByRole('button', { name: 'Download PFAF catalog', exact: true }).click();
  await expect(catalogCard.getByRole('button', { name: 'Delete catalog', exact: true })).toBeVisible({ timeout: 90_000 });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Explore plants', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search scientific or common names' });
  const named = catalogData.index.find(entry => entry.commonName.trim())!;
  await search.fill(named.commonName);
  await expect(page.locator('.catalog-list').getByText(named.scientificName, { exact: true })).toBeVisible();

  for (const [purpose, record] of [['zero', catalogData.zero], ['missing', catalogData.missing], ['provenance', catalogData.provenance]] as const) {
    await search.fill(record.sourceKey);
    await page.locator('.catalog-list button').filter({ has: page.getByText(record.sourceKey, { exact: true }) }).click();
    const dialog = page.getByRole('dialog', { name: record.sourceKey, exact: true });
    await expect(dialog.getByRole('heading', { name: 'Known hazards', exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Edible uses', exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Medicinal uses', exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Other uses', exact: true })).toBeVisible();
    if (purpose === 'zero') {
      const labels = ['Edibility rating', 'Medicinal rating', 'Other uses rating'];
      const field = ratings.findIndex(key => record.fields[key] === 0);
      await expect(dialog.locator('.ratings > div').filter({ hasText: labels[field] }).locator('dd')).toHaveText('0 / 5');
    }
    if (purpose === 'missing') {
      const labels = ['Edibility rating', 'Medicinal rating', 'Other uses rating'];
      const field = ratings.findIndex(key => record.fields[key] === null);
      await expect(dialog.locator('.ratings > div').filter({ hasText: labels[field] }).locator('dd')).toHaveText('Unavailable');
    }
    if (purpose === 'provenance') {
      await expect(dialog).toContainText('Record refresh: unknown; the source did not record a refresh date.');
      await expect(dialog).toContainText(catalogData.manifest.exportedAt);
      await expect(dialog).toContainText(catalogData.manifest.attribution);
      await expect(dialog).toContainText('The export date does not establish when this plant’s information was reviewed.');
      const references = ['edible_uses', 'medicinal_uses', 'other_uses'].map(key => String(record.fields[key] ?? '')).join('\n').match(/\[[^\]]+\]/)![0];
      await expect(dialog).toContainText(references);
    }
    await dialog.getByRole('button', { name: 'Close record', exact: true }).click();
  }
  await search.fill('NO-SUCH-PLANT-UI-ACCEPTANCE');
  await expect(page.getByRole('heading', { name: 'No matching names' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`${catalogData.manifest.taxonCount.toLocaleString()} saved records`);
  await page.getByText('Developer diagnostics', { exact: true }).click();
  await expect(page.locator('.diagnostics')).toContainText('Unavailable');
  await expect(page.locator('.diagnostics')).toContainText('Not installed');
  expect(dedicatedWorkers).toEqual([]);
  await testInfo.attach('tested-catalog-identity', { body: JSON.stringify({ id: catalogData.manifest.id, sourceSha256: catalogData.manifest.sourceSha256, records: catalogData.manifest.taxonCount, zero: catalogData.zero.sourceKey, missing: catalogData.missing.sourceKey, provenance: catalogData.provenance.sourceKey }), contentType: 'application/json' });
});

test('actual model metadata requires the matching catalog first and explicit size-labeled consent; no weights download', async ({ page, request, catalogData }) => {
  const pointer = await request.get('/model.json');
  expect(pointer.ok(), 'Prepare real model metadata before this acceptance check; no synthetic model manifest is substituted.').toBe(true);
  expect(pointer.headers()['content-type'], 'A missing /model.json may be served as the app HTML. Prepare the real model pack.').toContain('application/json');
  const { url } = await pointer.json() as { url: string };
  const response = await request.get(url);
  expect(response.ok()).toBe(true);
  const manifest = await response.json() as ModelManifest;
  expect(manifest.kind).toBe('bioclip2');
  expect(manifest.catalog.id).toBe(catalogData.manifest.id);
  expect(manifest.catalog.sourceSha256).toBe(catalogData.manifest.sourceSha256);
  expect(manifest.catalog.fullTaxonCount).toBe(catalogData.manifest.taxonCount);
  const weightRequests: string[] = [];
  const modelAssets = new Set(manifest.files.map(file => new URL(file.url, response.url()).href));
  page.on('request', request => { if (modelAssets.has(request.url())) weightRequests.push(request.url()); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Offline setup', exact: true }).click();
  const modelCard = page.locator('.pack-card').filter({ has: page.getByRole('heading', { name: 'On-device identification', exact: true }) });
  const consent = modelCard.getByRole('checkbox');
  const download = modelCard.getByRole('button', { name: 'Download identification pack', exact: true });
  await expect(consent).toBeDisabled();
  await expect(download).toBeDisabled();
  await expect(modelCard).toContainText('First download the PFAF plant catalog.');
  await expect(modelCard.locator('.pack-size')).toContainText(/\d+(?:\.\d+)? (?:bytes|KiB|MiB|GiB)/);
  expect(weightRequests).toEqual([]);

  const catalogCard = page.locator('.pack-card').filter({ has: page.getByRole('heading', { name: 'PFAF plant catalog', exact: true }) });
  await catalogCard.getByRole('button', { name: 'Download PFAF catalog', exact: true }).click();
  await expect(catalogCard.getByRole('button', { name: 'Delete catalog', exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(consent).toBeEnabled();
  await expect(consent).not.toBeChecked();
  await expect(download).toBeDisabled();
  await consent.check();
  await expect(download).toBeEnabled();
  await consent.uncheck();
  await expect(download).toBeDisabled();
  expect(weightRequests).toEqual([]);
  // Intentionally never click the enabled model action: this is consent/UI coverage, not inference proof.
});
