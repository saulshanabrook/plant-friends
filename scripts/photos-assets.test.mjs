import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createPhotoArchive, restorePhotos, selectPhotos, validatePhotoArchive, verifyPhotos, checkSiteSize } from './photos-assets.mjs';

const exec = promisify(execFile);
const receipt = data => ({ bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'photo-assets-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const photosId = 'a'.repeat(20), catalogId = 'b'.repeat(20);
  const folder = `photos/${photosId}`;
  await mkdir(join(source, folder, 'files'), { recursive: true });
  // Explicit tiny transport fixtures. Actual WebP decode is covered by Python preparation tests.
  const body = Buffer.from('small fabricated transport body');
  const file = { url: `files/${receipt(body).sha256}.webp`, ...receipt(body), width: 20, height: 10,
    originalUrl: 'https://example.test/flower.jpg', originalSha256: 'c'.repeat(64) };
  const photoId = createHash('sha256').update(file.originalUrl).digest('hex');
  const manifest = { schemaVersion: 1, id: photosId, catalogId, source: { repository: 'https://example.test/source', commit: 'd'.repeat(40), databaseSha256: 'e'.repeat(64) },
    images: { [photoId]: file }, plants: { 'pfaf:Abelia%20triflora': [{ photoId, credit: 'Raw © credit [1]' }], 'pfaf:Abies%20alba': [{ photoId, credit: null }] },
    counts: { photos: 1, uniqueFiles: 1, associations: 2, plantsWithPhotos: 2, plants: 2, photoBytes: body.length } };
  const manifestBody = JSON.stringify(manifest);
  await writeFile(join(source, folder, 'manifest.json'), manifestBody);
  await writeFile(join(source, folder, file.url), body);
  await writeFile(join(source, 'photos.json'), JSON.stringify({ url: `${folder}/manifest.json`, ...receipt(manifestBody) }));
  await writeFile(join(source, 'third-party-notices.txt'), 'Original attribution and source terms.');
  const metadata = { schemaVersion: 1, photosId, catalogId, files: [], archive: { url: 'https://github.com/saulshanabrook/plant-friends/releases/download/photos-fixture/photos-assets.tar.gz' } };
  return { root, source, folder, file, manifest, metadata, archive: join(root, 'photos.tar.gz') };
}

test('separate photo release round-trips exact receipts/credits while preserving core assets', async t => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'photos/old-pack'), { recursive: true });
  await writeFile(join(f.source, 'photos/old-pack/unselected.webp'), 'old');
  const selected = await createPhotoArchive(f.source, f.archive, f.metadata);
  assert.equal(selected.files.length, 4);
  assert.equal(selected.counts.associations, 2);
  assert.ok(!selected.files.some(file => file.path.includes('old-pack')));
  const target = join(f.root, 'restored');
  await mkdir(join(target, 'packs'), { recursive: true });
  await writeFile(join(target, 'packs/core-model.onnx'), 'existing core retained');
  assert.equal((await restorePhotos(f.archive, target, selected)).files, 4);
  assert.equal(await readFile(join(target, 'packs/core-model.onnx'), 'utf8'), 'existing core retained');
  assert.deepEqual(JSON.parse(await readFile(join(target, f.folder, 'manifest.json'))).plants, f.manifest.plants);
  assert.equal(await readFile(join(target, 'photos/NOTICE.txt'), 'utf8'), 'Original attribution and source terms.');
  await assert.rejects(restorePhotos(f.archive, target, selected), /preserves existing/);
  assert.ok((await checkSiteSize(target)).below950MB);
  await writeFile(join(target, f.folder, f.file.url), 'corrupt');
  await assert.rejects(verifyPhotos(target, selected), /integrity/);
});

test('archive digest is authenticated before extraction; extra files and links are rejected', async t => {
  const f = await fixture(t);
  const metadata = await createPhotoArchive(f.source, f.archive, f.metadata);
  const target = join(f.root, 'never-restored');
  await assert.rejects(restorePhotos(f.archive, target, { ...metadata, archive: { ...metadata.archive, sha256: '0'.repeat(64) } }), /SHA-256/);
  await writeFile(join(f.source, 'extra'), 'unexpected');
  await exec('tar', ['-czf', f.archive, '-C', f.source, 'extra']);
  const extra = { ...metadata, archive: { ...metadata.archive, ...receipt(await readFile(f.archive)) } };
  await assert.rejects(validatePhotoArchive(f.archive, extra), /exactly the pinned regular files/);
  const links = join(f.root, 'links');
  await mkdir(links);
  await symlink('outside', join(links, 'photos.json'));
  await exec('tar', ['-czf', f.archive, '-C', links, 'photos.json']);
  const linked = { ...metadata, files: metadata.files.filter(file => file.path === 'photos.json'), archive: { ...metadata.archive, ...receipt(await readFile(f.archive)) } };
  await assert.rejects(validatePhotoArchive(f.archive, linked), /regular files/);
});

test('descriptor corruption, wrong catalog binding, missing credits and unselected versions fail', async t => {
  const f = await fixture(t);
  await assert.rejects(selectPhotos(f.source, { ...f.metadata, catalogId: 'f'.repeat(20) }), /catalog binding/);
  await writeFile(join(f.source, f.folder, f.file.url), 'changed');
  await assert.rejects(selectPhotos(f.source, f.metadata), /integrity/);
  const second = await fixture(t);
  const selected = await createPhotoArchive(second.source, second.archive, second.metadata);
  const target = join(second.root, 'restored');
  await restorePhotos(second.archive, target, selected);
  await mkdir(join(target, 'photos/old'), { recursive: true });
  await writeFile(join(target, 'photos/old/extra'), 'unselected');
  await assert.rejects(verifyPhotos(target, selected), /Unselected photo asset/);
  delete second.manifest.plants['pfaf:Abelia%20triflora'][0].credit;
  const invalid = JSON.stringify(second.manifest);
  await writeFile(join(second.source, second.folder, 'manifest.json'), invalid);
  await writeFile(join(second.source, 'photos.json'), JSON.stringify({ url: `${second.folder}/manifest.json`, ...receipt(invalid) }));
  await assert.rejects(selectPhotos(second.source, second.metadata), /credit/);
});
