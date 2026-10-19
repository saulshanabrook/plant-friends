import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const origin = 'https://deployment.invalid/';
const generated = ['catalog.json', 'model.json', 'packs', 'runtime', 'fixtures'];

function assetPath(value, base = origin) {
  const url = new URL(value, new URL(base, origin));
  const path = decodeURIComponent(url.pathname.slice(1));
  if (url.origin !== new URL(origin).origin || url.search || url.hash ||
      !/^[A-Za-z0-9._/-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error(`Unsafe deployment asset path: ${value}`);
  return path;
}

async function digest(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest('hex') };
}

function checkMetadata(metadata) {
  if (metadata.schemaVersion !== 1 || !/^[a-f0-9]{20}$/.test(metadata.catalogId) ||
      !/^[a-f0-9]{20}$/.test(metadata.modelId) || !/^\d+\.\d+\.\d+$/.test(metadata.runtimeVersion) ||
      !Array.isArray(metadata.files)) throw new Error('Invalid deployment asset metadata.');
  const names = new Set();
  for (const file of metadata.files) {
    if (assetPath(file.path) !== file.path || names.has(file.path) ||
        !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new Error('Invalid or duplicate deployment file receipt.');
    names.add(file.path);
  }
}

export async function selectAssets(source, metadata, packageFile = 'node_modules/onnxruntime-web/package.json', notice = join(source, 'third-party-notices.txt')) {
  checkMetadata(metadata);
  const version = JSON.parse(await readFile(packageFile, 'utf8')).version;
  if (version !== metadata.runtimeVersion) throw new Error(`Installed ONNX Runtime ${version} differs from pinned ${metadata.runtimeVersion}.`);
  const files = new Map();
  const add = async (path, expected) => {
    const actual = await digest(join(source, path));
    if (expected && (expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256))
      throw new Error(`Deployment asset integrity failed: ${path}`);
    const prior = files.get(path);
    if (prior && (prior.bytes !== actual.bytes || prior.sha256 !== actual.sha256)) throw new Error(`Conflicting asset: ${path}`);
    files.set(path, { path, ...actual });
    return JSON.parse(/\.json$/.test(path) ? await readFile(join(source, path), 'utf8') : 'null');
  };
  const manifests = {};
  for (const [kind, id, folder] of [['catalog', metadata.catalogId, 'pfaf'], ['model', metadata.modelId, 'bioclip2']]) {
    const pointer = await add(`${kind}.json`);
    const path = assetPath(pointer.url);
    if (path !== `packs/${folder}/${id}/manifest.json`) throw new Error(`The active ${kind} pointer is not the pinned deployment pack.`);
    const manifest = await add(path);
    if (manifest.id !== id || manifest.schemaVersion !== 1 || manifest.kind !== folder || !Array.isArray(manifest.files))
      throw new Error(`Invalid ${kind} deployment manifest.`);
    manifests[kind] = { path, manifest };
    const externalData = kind === 'model' ? manifest.model.externalData ?? [] : [];
    if (!Array.isArray(externalData) || externalData.some(entry => !entry?.file)) throw new Error('Invalid model external-data descriptors.');
    const variant = externalData.length ? 'jspi' : 'asyncify';
    for (const file of manifest.files) {
      const target = assetPath(file.url, path);
      const allowed = target.startsWith(`packs/${folder}/${id}/`) ||
        (kind === 'model' && ([manifest.model.file, ...externalData.map(entry => entry.file)]
          .some(weight => target === `packs/bioclip2/weights/${weight.sha256}.onnx`) ||
          ['mjs', 'wasm'].some(ext => target === `runtime/${version}/ort-wasm-simd-threaded.${variant}.${ext}`)));
      if (!allowed) throw new Error(`Unexpected asset outside the selected pack: ${target}`);
      await add(target, file);
    }
  }
  const catalog = manifests.catalog.manifest;
  const model = manifests.model.manifest;
  if (model.catalog.id !== catalog.id || model.catalog.sourceSha256 !== catalog.sourceSha256 ||
      model.catalog.taxonCount !== catalog.taxonCount || model.catalog.fullTaxonCount !== catalog.taxonCount ||
      assetPath(model.catalog.url, manifests.model.path) !== manifests.catalog.path || model.runtime.version !== version)
    throw new Error('Deployment requires the matching complete catalog and runtime.');
  const externalData = model.model.externalData ?? [];
  for (const file of [model.model.file, ...externalData.map(entry => entry.file), model.vectors.file, model.catalog.rows, ...model.runtime.files]) {
    const selected = files.get(assetPath(file.url, manifests.model.path));
    if (!selected || selected.bytes !== file.bytes || selected.sha256 !== file.sha256)
      throw new Error('A required model/runtime descriptor is absent or inconsistent.');
  }
  const runtime = await add('runtime/manifest.json');
  const variant = externalData.length ? 'jspi' : 'asyncify';
  const expectedRuntimePaths = ['mjs', 'wasm'].map(ext => `runtime/${version}/ort-wasm-simd-threaded.${variant}.${ext}`);
  if (runtime.version !== version || runtime.files.length !== 2 || model.runtime.files.length !== 2)
    throw new Error(`Expected exactly the pinned native ${variant} runtime pair.`);
  if (new Set(runtime.files.map(file => assetPath(file.url, 'runtime/manifest.json'))).size !== 2 ||
      expectedRuntimePaths.some(path => !model.runtime.files.some(file => assetPath(file.url, manifests.model.path) === path)))
    throw new Error(`The model and runtime must identify the same complete ${variant} pair.`);
  for (const file of runtime.files) {
    const path = assetPath(file.url, 'runtime/manifest.json');
    if (!expectedRuntimePaths.includes(path)) throw new Error('Unexpected runtime file.');
    await add(path, file);
  }
  files.set('packs/NOTICE.txt', { path: 'packs/NOTICE.txt', ...await digest(notice) });
  const selected = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { ...metadata, files: selected, totalBytes: selected.reduce((sum, file) => sum + file.bytes, 0) };
}

export async function verifyAssets(target, metadata, packageFile) {
  checkMetadata(metadata);
  const current = await selectAssets(target, metadata, packageFile, join(target, 'packs/NOTICE.txt'));
  if (JSON.stringify(current.files) !== JSON.stringify(metadata.files) || current.totalBytes !== metadata.totalBytes)
    throw new Error('Selected deployment files differ from the pinned receipts.');
  const allowed = new Set(metadata.files.map(file => file.path));
  async function walk(path) {
    let info;
    try { info = await lstat(join(target, path)); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Deployment must not contain symlinks: ${path}`);
    if (info.isDirectory()) for (const entry of await readdir(join(target, path))) await walk(`${path}/${entry}`);
    else if (!allowed.has(path)) throw new Error(`Unselected generated asset would be published: ${path}`);
  }
  for (const path of generated) await walk(path);
  return { files: metadata.files.length, bytes: metadata.totalBytes, catalogId: metadata.catalogId, modelId: metadata.modelId };
}

export async function validateArchive(archive, metadata) {
  const actual = await digest(archive);
  if (!metadata.archive || actual.bytes !== metadata.archive.bytes || actual.sha256 !== metadata.archive.sha256)
    throw new Error('Deployment archive size or SHA-256 does not match the pinned receipt.');
  const listing = (await exec('tar', ['-tzf', archive])).stdout.trimEnd().split('\n');
  const verbose = (await exec('tar', ['-tvzf', archive])).stdout.trimEnd().split('\n');
  if (listing.length !== metadata.files.length || new Set(listing).size !== listing.length ||
      listing.some(path => !metadata.files.some(file => file.path === path)) || verbose.some(line => !line.startsWith('-')))
    throw new Error('Archive must contain exactly the selected regular files, with no links or extra paths.');
}

export async function restoreAssets(archive, target, metadata, packageFile) {
  checkMetadata(metadata);
  await validateArchive(archive, metadata); // Authenticate the archive before any extraction.
  for (const path of generated) {
    try { await lstat(join(target, path)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Restore requires a clean generated-assets target; preserving existing ${join(target, path)}.`);
  }
  const staging = await mkdtemp(join(tmpdir(), 'plant-pages-restore-'));
  try {
    await exec('tar', ['-xzf', archive, '-C', staging, '--no-same-owner', '--no-same-permissions']);
    await verifyAssets(staging, metadata, packageFile); // Validate every file before publishing it to public/.
    for (const file of metadata.files) {
      const destination = join(target, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(staging, file.path), destination);
    }
    return await verifyAssets(target, metadata, packageFile);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function createArchive(source, archive, metadata, packageFile) {
  const selected = await selectAssets(source, metadata, packageFile);
  await mkdir(dirname(archive), { recursive: true });
  const temporary = `${archive}.partial-${process.pid}`;
  const auxiliary = await mkdtemp(join(tmpdir(), 'plant-pages-notice-'));
  try {
    await mkdir(join(auxiliary, 'packs'));
    await copyFile(join(source, 'third-party-notices.txt'), join(auxiliary, 'packs/NOTICE.txt'));
    await exec('tar', ['--format=ustar', '-czf', temporary, '-C', source,
      ...selected.files.filter(file => file.path !== 'packs/NOTICE.txt').map(file => file.path),
      '-C', auxiliary, 'packs/NOTICE.txt']);
    selected.archive = { ...metadata.archive, ...await digest(temporary) };
    await validateArchive(temporary, selected);
    await rename(temporary, archive);
    return selected;
  } finally {
    await rm(temporary, { force: true });
    await rm(auxiliary, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = Object.fromEntries(args.reduce((pairs, arg, index) => index % 2 ? pairs : [...pairs, [arg, args[index + 1]]], []));
  if (args.length % 2 || Object.keys(options).some(key => !['--source', '--target', '--archive', '--metadata'].includes(key)))
    throw new Error('Use prepare/create/restore/verify with --metadata, --source, --target, or --archive path pairs.');
  const metadataFile = resolve(options['--metadata'] ?? 'deployment/assets.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  const source = resolve(options['--source'] ?? 'public');
  const target = resolve(options['--target'] ?? 'public');
  if (command === 'prepare' || command === 'create') {
    const selected = command === 'create'
      ? await createArchive(source, resolve(options['--archive'] ?? '.cache/pages-assets.tar.gz'), metadata)
      : await selectAssets(source, metadata);
    if (command === 'prepare') selected.archive = { ...metadata.archive, bytes: null, sha256: null };
    await writeFile(metadataFile, JSON.stringify(selected, null, 2) + '\n');
    console.log(JSON.stringify({ files: selected.files.length, bytes: selected.totalBytes, archive: selected.archive }));
  } else if (command === 'verify') console.log(JSON.stringify(await verifyAssets(target, metadata)));
  else if (command === 'restore') {
    if (options['--archive']) console.log(JSON.stringify(await restoreAssets(resolve(options['--archive']), target, metadata)));
    else {
      if (!metadata.archive || !/^https:\/\/github\.com\/saulshanabrook\/plant-friends\/releases\/download\//.test(metadata.archive.url) ||
          !Number.isSafeInteger(metadata.archive.bytes) || metadata.archive.bytes <= 0 || !/^[a-f0-9]{64}$/.test(metadata.archive.sha256))
        throw new Error('Pin the public release archive URL, size, and SHA-256 before restoring deployment assets.');
      const temporary = await mkdtemp(join(tmpdir(), 'plant-pages-download-'));
      try {
        const archive = join(temporary, 'assets.tar.gz');
        const response = await fetch(metadata.archive.url);
        if (!response.ok || !response.body) throw new Error(`Release download failed: HTTP ${response.status}`);
        let received = 0;
        const limit = new Transform({ transform(chunk, encoding, callback) {
          received += chunk.length;
          callback(received > metadata.archive.bytes ? new Error('Release archive exceeds its pinned size.') : null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(archive));
        console.log(JSON.stringify(await restoreAssets(archive, target, metadata)));
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
  } else throw new Error('Expected prepare, create, restore, or verify.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
