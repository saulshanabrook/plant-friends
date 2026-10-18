import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from './fixtures';

// Actual generated catalog/photo metadata selects a plant known to have photos.
// The app must not request any photo asset while the real encoder is held. This
// checks download priority, not inference or a simulated installed model.
test.use({ serviceWorkers: 'block' });

test('photo metadata and native table/detail images wait until the model is ready', async ({ page, context, catalogData }) => {
  const publicRoot = resolve(process.env.PLANT_FRIENDS_TEST_PUBLIC ?? 'public');
  const pointer = JSON.parse(await readFile(resolve(publicRoot, 'photos.json'), 'utf8')) as { url: string };
  const album = JSON.parse(await readFile(resolve(publicRoot, pointer.url), 'utf8')) as {
    catalogId: string; plants: Record<string, { photoId: string; credit: string | null }[]>;
  };
  expect(album.catalogId).toBe(catalogData.manifest.id);
  const plant = catalogData.index.find(entry => album.plants[entry.id]?.length > 1)!;
  expect(plant).toBeTruthy();
  const photoRequests: string[] = [];
  let modelRequested = false;
  page.on('request', request => { if (/\/photos(?:\.json|\/)/.test(new URL(request.url()).pathname)) photoRequests.push(request.url()); });
  await context.route('**/*.onnx*', () => { modelRequested = true; });
  await page.goto('/');
  await expect.poll(() => modelRequested).toBe(true);
  const search = page.getByRole('searchbox', { name: 'Search plants', exact: true });
  await search.fill(plant.scientificName);
  const table = page.getByRole('table');
  await expect(table.getByRole('img')).toHaveCount(0);
  await table.getByRole('button', { name: plant.scientificName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: plant.scientificName, exact: true });
  const gallery = dialog.getByRole('region', { name: 'Reference photos', exact: true });
  await expect(gallery).toContainText('Reference photos are not available yet.');
  await expect(gallery.getByRole('img')).toHaveCount(0);
  expect(photoRequests).toEqual([]);
});
