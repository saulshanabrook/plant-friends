import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import plan from './download-plan.json';

interface Receipt { catalogId: string; modelId?: string; photosId?: string; runtimeVersion?: string; files: { path: string; bytes: number }[] }
test('the tiny browser size plan matches both deployment receipts, excluding archives and notices', () => {
  const assetBytes = readFileSync(new URL('../../deployment/assets.json', import.meta.url));
  const photoBytes = readFileSync(new URL('../../deployment/photos.json', import.meta.url));
  const assets = JSON.parse(assetBytes.toString()) as Receipt;
  const photos = JSON.parse(photoBytes.toString()) as Receipt;
  const sum = (receipt: Receipt, include: (path: string) => boolean) => receipt.files.filter(file => include(file.path)).reduce((total, file) => total + file.bytes, 0);
  expect(plan).toEqual({ schemaVersion: 1,
    receipts: { assetsSha256: createHash('sha256').update(assetBytes).digest('hex'), photosSha256: createHash('sha256').update(photoBytes).digest('hex') },
    catalog: { id: assets.catalogId, bytes: sum(assets, path => path.startsWith('packs/pfaf/') && !path.endsWith('/manifest.json')) },
    model: { id: assets.modelId, bytes: sum(assets, path => (path.startsWith('packs/bioclip2/') || path.startsWith(`runtime/${assets.runtimeVersion}/`)) && !path.endsWith('/manifest.json')) },
    photos: { id: photos.photosId, catalogId: photos.catalogId, imageBytes: sum(photos, path => path.endsWith('.webp')),
      metadataBytes: sum(photos, path => path === 'photos.json' || path.endsWith('/manifest.json')) },
  });
  expect(plan.photos.catalogId).toBe(plan.catalog.id);
  expect(JSON.stringify(plan).length).toBeLessThan(1_024);
});
