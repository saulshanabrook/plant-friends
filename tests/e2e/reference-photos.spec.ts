import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { CatalogEntry } from '../../src/assets/manifest';

// Actual generated reference-photo index and WebP bytes. Encoder requests are
// aborted; this UI acceptance does not claim inference or all-photo offline setup.
test.use({ serviceWorkers: 'block' });

test('real table/detail photos retain every association, exact credit text and source links; missing photos stay explicit', async ({ page, context, request }) => {
  const catalogPointer = await request.get('/catalog.json');
  const catalogResponse = await request.get((await catalogPointer.json()).url);
  const catalog = await catalogResponse.json();
  const index = await (await request.get(new URL(catalog.indexFile, catalogResponse.url()).href)).json() as CatalogEntry[];
  const pointer = await request.get('/photos.json');
  expect(pointer.ok(), 'Prepare the actual reference photo assets before UI acceptance.').toBe(true);
  const photoResponse = await request.get((await pointer.json()).url);
  const album = await photoResponse.json() as {
    catalogId: string;
    plants: Record<string, { photoId: string; credit: string | null }[]>;
    images: Record<string, { url: string; sha256: string; originalUrl: string }>;
  };
  expect(album.catalogId).toBe(catalog.id);
  const multiple = index.find(entry => album.plants[entry.id]?.length > 1 && album.plants[entry.id].some(photo => photo.credit !== null))!;
  const missing = index.find(entry => album.plants[entry.id]?.length === 0)!;
  expect(multiple).toBeTruthy(); expect(missing).toBeTruthy();
  const requestedImages: string[] = [];
  page.on('request', request => { if (/\/photos\/[^/]+\/files\//.test(request.url())) requestedImages.push(request.url()); });
  await context.route('**/*.onnx*', route => route.abort('blockedbyclient'));
  await page.goto('/');
  const search = page.getByRole('searchbox', { name: 'Search plants', exact: true });
  await expect(search).toBeVisible({ timeout: 90_000 });
  await search.fill(multiple.scientificName);
  const open = page.getByRole('table').getByRole('button', { name: multiple.scientificName, exact: true });
  const row = page.getByRole('table').locator('tbody tr').filter({ has: page.getByRole('button', { name: multiple.scientificName, exact: true }) });
  await expect(row.getByRole('img')).toHaveCount(1);
  await open.click();
  const dialog = page.getByRole('dialog', { name: multiple.scientificName, exact: true });
  const gallery = dialog.getByRole('region', { name: 'Reference photos', exact: true });
  const associations = album.plants[multiple.id];
  await expect(gallery.locator('figure')).toHaveCount(associations.length);
  for (const [position, association] of associations.entries()) {
    const source = album.images[association.photoId];
    const url = new URL(source.url, photoResponse.url()).href;
    const figure = gallery.locator('figure').nth(position);
    const image = figure.getByRole('img');
    expect(await image.getAttribute('src')).toBe(url);
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await figure.locator('figcaption span').textContent()).toBe(association.credit ?? 'Credit not recorded.');
    await expect(figure.getByRole('link', { name: 'Original photo source', exact: true })).toHaveAttribute('href', source.originalUrl);
    const bytes = await request.get(url);
    expect(bytes.ok()).toBe(true);
    expect(createHash('sha256').update(await bytes.body()).digest('hex')).toBe(source.sha256);
  }
  await dialog.getByRole('button', { name: 'Close plant details', exact: true }).click();
  await search.fill(missing.scientificName);
  const absent = page.getByRole('table').getByRole('button', { name: missing.scientificName, exact: true });
  await expect(page.getByRole('table').locator('tbody tr').filter({ has: page.getByRole('button', { name: missing.scientificName, exact: true }) }).getByRole('img')).toHaveCount(0);
  await absent.click();
  await expect(page.getByRole('dialog')).toContainText('No reference photos recorded for this plant.');
  await expect(page.getByRole('dialog').locator('.reference-gallery img')).toHaveCount(0);
  const origin = new URL(page.url()).origin;
  expect(requestedImages.length).toBeGreaterThan(0);
  expect(requestedImages.every(url => new URL(url).origin === origin)).toBe(true);
});
