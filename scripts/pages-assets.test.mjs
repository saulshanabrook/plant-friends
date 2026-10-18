import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createArchive, restoreAssets, selectAssets, validateArchive, verifyAssets } from './pages-assets.mjs';

// Tiny fabricated bytes exercise deployment transport, never model inference.
const scratch = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plant-pages-test-'));
  scratch.push(root);
  const source = join(root, 'source');
  const packageFile = join(root, 'ort-package.json');
  const metadata = { schemaVersion: 1, catalogId: 'a'.repeat(20), modelId: 'b'.repeat(20), runtimeVersion: '1.30.0',
    archive: { url: 'https://example.test/fixture.tar.gz', bytes: null, sha256: null }, files: [] };
  async function asset(path, content) {
    const bytes = Buffer.from(content);
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), bytes);
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const catalogPath = `packs/pfaf/${metadata.catalogId}/manifest.json`;
  const modelPath = `packs/bioclip2/${metadata.modelId}/manifest.json`;
  const index = { url: 'index.json', ...await asset(`packs/pfaf/${metadata.catalogId}/index.json`, '["fixture index"]') };
  const weightContent = 'fabricated encoder';
  const weightHash = createHash('sha256').update(weightContent).digest('hex');
  const weights = { url: `../weights/${weightHash}.onnx`, ...await asset(`packs/bioclip2/weights/${weightHash}.onnx`, weightContent) };
  const vectors = { url: 'vectors.f32', ...await asset(`packs/bioclip2/${metadata.modelId}/vectors.f32`, 'fabricated vectors') };
  const rows = { url: 'rows.json', ...await asset(`packs/bioclip2/${metadata.modelId}/rows.json`, '["fixture"]') };
  const runtime = [];
  for (const ext of ['mjs', 'wasm']) {
    const path = `runtime/1.30.0/ort-wasm-simd-threaded.asyncify.${ext}`;
    runtime.push({ url: `../../../${path}`, ...await asset(path, `fabricated runtime ${ext}`) });
  }
  const catalog = { schemaVersion: 1, kind: 'pfaf', id: metadata.catalogId, sourceSha256: 'c'.repeat(64), taxonCount: 1, files: [index] };
  const model = { schemaVersion: 1, kind: 'bioclip2', id: metadata.modelId,
    model: { file: weights }, vectors: { file: vectors },
    catalog: { id: metadata.catalogId, sourceSha256: catalog.sourceSha256, taxonCount: 1, fullTaxonCount: 1,
      url: `../../pfaf/${metadata.catalogId}/manifest.json`, rows },
    runtime: { version: metadata.runtimeVersion, files: runtime }, files: [weights, vectors, rows, ...runtime] };
  await asset(catalogPath, JSON.stringify(catalog));
  await asset(modelPath, JSON.stringify(model));
  await asset('catalog.json', JSON.stringify({ url: catalogPath }));
  await asset('model.json', JSON.stringify({ url: modelPath }));
  await asset('runtime/manifest.json', JSON.stringify({ version: metadata.runtimeVersion,
    files: runtime.map(file => ({ ...file, url: file.url.replace('../../../runtime/', '') })) }));
  await asset('packs/old/not-selected.onnx', 'old pack');
  await asset('fixtures/photos/private.jpg', 'not deployment content');
  await asset('third-party-notices.txt', 'Fabricated attribution notice.');
  await writeFile(packageFile, JSON.stringify({ version: metadata.runtimeVersion }));
  return { root, source, packageFile, metadata, model, modelPath };
}

test('selection excludes old packs/photos and archive restores only exact receipts, preserving ordinary public notices', async () => {
  const f = await fixture();
  const selected = await selectAssets(f.source, f.metadata, f.packageFile);
  assert.equal(selected.files.length, 12);
  assert.equal(selected.files.some(file => /old|private/.test(file.path)), false);
  assert.equal(await readFile(join(f.source, 'packs/old/not-selected.onnx'), 'utf8'), 'old pack');
  const archive = join(f.root, 'selected.tar.gz');
  const pinned = await createArchive(f.source, archive, f.metadata, f.packageFile);
  await assert.rejects(readFile(join(f.source, 'packs/NOTICE.txt')), { code: 'ENOENT' });
  const target = join(f.root, 'public');
  await mkdir(target);
  await writeFile(join(target, 'notices.html'), 'source notices');
  await restoreAssets(archive, target, pinned, f.packageFile);
  assert.equal(await readFile(join(target, 'notices.html'), 'utf8'), 'source notices');
  assert.equal((await verifyAssets(target, pinned, f.packageFile)).files, 12);
  assert.equal(await readFile(join(target, 'packs/NOTICE.txt'), 'utf8'), 'Fabricated attribution notice.');
  await assert.rejects(restoreAssets(archive, target, pinned, f.packageFile), /preserving existing/);
  await mkdir(join(target, 'fixtures'));
  await writeFile(join(target, 'fixtures', 'unselected.jpg'), 'unselected');
  await assert.rejects(verifyAssets(target, pinned, f.packageFile), /Unselected generated asset/);
});

test('archive authentication fails before extraction and per-file receipts detect later corruption', async () => {
  const f = await fixture();
  const archive = join(f.root, 'selected.tar.gz');
  const pinned = await createArchive(f.source, archive, f.metadata, f.packageFile);
  const wrong = structuredClone(pinned);
  wrong.archive.sha256 = '0'.repeat(64);
  const target = join(f.root, 'target');
  await assert.rejects(restoreAssets(archive, target, wrong, f.packageFile), /archive size or SHA-256/);
  await restoreAssets(archive, target, pinned, f.packageFile);
  await writeFile(join(target, `packs/bioclip2/${pinned.modelId}/vectors.f32`), 'corrupt vectors');
  await assert.rejects(verifyAssets(target, pinned, f.packageFile), /integrity failed/);
});

test('even an authenticated archive cannot introduce links or extra paths', async () => {
  const f = await fixture();
  const archive = join(f.root, 'selected.tar.gz');
  const pinned = await createArchive(f.source, archive, f.metadata, f.packageFile);
  await mkdir(join(f.source, 'packs'), { recursive: true });
  await writeFile(join(f.source, 'packs/NOTICE.txt'), 'Fabricated attribution notice.');
  const file = `packs/bioclip2/${pinned.modelId}/vectors.f32`;
  await rm(join(f.source, file));
  await symlink('rows.json', join(f.source, file));
  await promisify(execFile)('tar', ['--format=ustar', '-czf', archive, '-C', f.source, ...pinned.files.map(entry => entry.path)]);
  const bytes = await readFile(archive);
  pinned.archive.bytes = bytes.length;
  pinned.archive.sha256 = createHash('sha256').update(bytes).digest('hex');
  await assert.rejects(validateArchive(archive, pinned), /regular files/);
  await rm(join(f.source, file));
  await writeFile(join(f.source, file), 'fabricated vectors');
  await promisify(execFile)('tar', ['--format=ustar', '-czf', archive, '-C', f.source,
    ...pinned.files.map(entry => entry.path), 'fixtures/photos/private.jpg']);
  const extraBytes = await readFile(archive);
  pinned.archive.bytes = extraBytes.length;
  pinned.archive.sha256 = createHash('sha256').update(extraBytes).digest('hex');
  await assert.rejects(validateArchive(archive, pinned), /extra paths/);
});

test('runtime version drift and partial catalog pointers fail selection', async () => {
  const f = await fixture();
  await writeFile(f.packageFile, '{"version":"1.29.0"}');
  await assert.rejects(selectAssets(f.source, f.metadata, f.packageFile), /differs from pinned/);
  await writeFile(f.packageFile, '{"version":"1.30.0"}');
  f.model.catalog.taxonCount = 0;
  await writeFile(join(f.source, f.modelPath), JSON.stringify(f.model));
  await assert.rejects(selectAssets(f.source, f.metadata, f.packageFile), /matching complete catalog/);
});
