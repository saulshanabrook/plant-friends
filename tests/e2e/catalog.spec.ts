import { expect, sourceTest as test } from './fixtures';
import type { ModelManifest } from '../../src/assets/manifest';

// Offline installation and automatic setup intentionally keep fresh contexts.
const ratings = ['edibility_rating', 'medicinal_rating', 'other_uses_rating'] as const;

test.setTimeout(120_000);

test('real PFAF search and source details work after an offline reload, without WebGPU or a model', async ({ page, context, catalogData }, testInfo) => {
  // Remove capability only; catalog responses, installation, and detail reads use the actual product APIs.
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { configurable: true, get: () => undefined }));
  const dedicatedWorkers: string[] = [];
  page.on('worker', worker => dedicatedWorkers.push(worker.url()));
  await page.goto('/?diagnostics=1');
  await page.waitForFunction(() => Boolean(window.plantFriends));
  await page.evaluate(() => window.plantFriends.install('pfaf'));
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.goto('/');
  const search = page.getByRole('searchbox', { name: 'Search plants' });
  const named = catalogData.index.find(entry => entry.commonName.trim())!;
  await search.fill(named.commonName);
  await expect(page.getByRole('table').getByText(named.scientificName, { exact: true })).toBeVisible();

  for (const [purpose, record] of [['zero', catalogData.zero], ['missing', catalogData.missing], ['provenance', catalogData.provenance]] as const) {
    await search.fill(record.sourceKey);
    await page.getByRole('table').getByRole('button', { name: record.sourceKey, exact: true }).click();
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
      await dialog.getByText('Source and freshness', { exact: true }).click();
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
  await expect(page.getByRole('table')).toContainText('No matching plants.');
  await search.fill('');
  await expect(page.getByRole('region', { name: 'Plant catalog' })).toContainText(`of ${catalogData.manifest.taxonCount.toLocaleString()} plants`);
  await page.getByText('Diagnostics', { exact: true }).click();
  await expect(page.locator('.diagnostics')).toContainText('Unavailable');
  await expect(page.locator('.diagnostics')).toContainText('Not installed');
  expect(dedicatedWorkers).toEqual([]);
  await testInfo.attach('tested-catalog-identity', { body: JSON.stringify({ id: catalogData.manifest.id, sourceSha256: catalogData.manifest.sourceSha256, records: catalogData.manifest.taxonCount, zero: catalogData.zero.sourceKey, missing: catalogData.missing.sourceKey, provenance: catalogData.provenance.sourceKey }), contentType: 'application/json' });
});

test.describe('automatic setup controls', () => {
  test.use({ serviceWorkers: 'block' });
  test('automatic setup shows measured sizes without management controls or consent checkboxes', async ({ page, request }) => {
    const pointer = await request.get('/model.json');
    const response = await request.get((await pointer.json()).url);
    const manifest = await response.json() as ModelManifest;
    const encoder = new URL(manifest.model.file.url, response.url()).href;
    let release: (() => Promise<void>) | undefined;
    await page.route('**/*.onnx*', route => route.abort('blockedbyclient'));
    await page.route(encoder, route => { release = () => route.abort().catch(() => undefined); });
    await page.goto('/');
    await expect.poll(() => Boolean(release)).toBe(true);
    const size = `${(manifest.files.reduce((sum, file) => sum + file.bytes, 0) / 1024 / 1024).toFixed(1)} MiB`;
    await expect(page.locator('#setup-status')).toContainText(size);
    await expect(page.locator('#setup-status button')).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /download|pause|resume|delete/i })).toHaveCount(0);
    await release!();
  });
});
