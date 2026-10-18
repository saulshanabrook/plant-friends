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
const hashPattern = /^[a-f0-9]{64}$/;
const maxArchiveBytes = 256 * 1024 * 1024;
const maxListingBytes = 16 * 1024 * 1024;
const maxManifestBytes = 32 * 1024 * 1024;

async function digest(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular photo asset: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest('hex') };
}

function checkMetadata(metadata) {
  if (metadata.schemaVersion !== 1 || !/^[a-f0-9]{20}$/.test(metadata.photosId) ||
      !/^[a-f0-9]{20}$/.test(metadata.catalogId) || !Array.isArray(metadata.files))
    throw new Error('Invalid reference-photo deployment metadata.');
  const names = new Set();
  for (const file of metadata.files) {
    const allowed = file.path === 'photos.json' || file.path === 'photos/NOTICE.txt' ||
      file.path === `photos/${metadata.photosId}/manifest.json` ||
      new RegExp(`^photos/${metadata.photosId}/files/[a-f0-9]{64}\\.webp$`).test(file.path);
    if (!allowed || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !hashPattern.test(file.sha256))
      throw new Error('Invalid or duplicate photo file receipt.');
    names.add(file.path);
  }
}

export async function selectPhotos(source, metadata, notice = join(source, 'third-party-notices.txt')) {
  checkMetadata(metadata);
  const files = new Map();
  const add = async (path, expected) => {
    const receipt = { path, ...await digest(join(source, path)) };
    if (expected && (expected.bytes !== receipt.bytes || expected.sha256 !== receipt.sha256))
      throw new Error(`Reference-photo integrity failed: ${path}`);
    files.set(path, receipt);
    return receipt;
  };
  const pointerReceipt = await add('photos.json');
  if (pointerReceipt.bytes > 64 * 1024) throw new Error('Photo pointer is too large.');
  const pointer = JSON.parse(await readFile(join(source, 'photos.json'), 'utf8'));
  const manifestPath = `photos/${metadata.photosId}/manifest.json`;
  if (pointer.url !== manifestPath) throw new Error('The photo pointer is not the pinned deployment pack.');
  const manifestReceipt = await add(manifestPath, pointer);
  if (manifestReceipt.bytes > maxManifestBytes) throw new Error('Photo manifest is too large.');
  const manifest = JSON.parse(await readFile(join(source, manifestPath), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.id !== metadata.photosId || manifest.catalogId !== metadata.catalogId ||
      typeof manifest.source?.repository !== 'string' || !manifest.source.repository ||
      !/^[a-f0-9]{40}$/.test(manifest.source.commit) || !hashPattern.test(manifest.source.databaseSha256) ||
      !manifest.images || Array.isArray(manifest.images) || !manifest.plants || Array.isArray(manifest.plants))
    throw new Error('Invalid reference-photo manifest or catalog binding.');
  const physical = new Map();
  for (const [id, image] of Object.entries(manifest.images)) {
    let url;
    try { url = new URL(image.originalUrl); } catch { throw new Error('Invalid original photo URL.'); }
    if (!hashPattern.test(id) || createHash('sha256').update(image.originalUrl).digest('hex') !== id ||
        !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        !hashPattern.test(image.sha256) || !hashPattern.test(image.originalSha256) ||
        image.url !== `files/${image.sha256}.webp` || !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > 4 * 1024 * 1024 ||
        ![image.width, image.height].every(value => Number.isInteger(value) && value >= 1 && value <= 640))
      throw new Error('Invalid reference-photo descriptor.');
    const path = `photos/${metadata.photosId}/${image.url}`;
    const prior = physical.get(path);
    if (prior && ['bytes', 'sha256', 'width', 'height'].some(key => prior[key] !== image[key]))
      throw new Error('Conflicting descriptors for a shared photo file.');
    physical.set(path, image);
  }
  let associations = 0;
  let plantsWithPhotos = 0;
  const referenced = new Set();
  for (const [id, photos] of Object.entries(manifest.plants)) {
    if (!id.startsWith('pfaf:') || id.length <= 5 || !Array.isArray(photos)) throw new Error('Invalid plant photo associations.');
    const seen = new Set();
    for (const photo of photos) {
      if (!manifest.images[photo.photoId] || seen.has(photo.photoId) || (photo.credit !== null && typeof photo.credit !== 'string'))
        throw new Error('Missing/duplicate photo or invalid original credit.');
      seen.add(photo.photoId); referenced.add(photo.photoId); associations++;
    }
    plantsWithPhotos += photos.length > 0;
  }
  if (referenced.size !== Object.keys(manifest.images).length) throw new Error('Unassociated image in the photo manifest.');
  for (const [path, image] of [...physical].sort(([a], [b]) => a.localeCompare(b, 'en'))) await add(path, image);
  const counts = { photos: Object.keys(manifest.images).length, uniqueFiles: physical.size, associations,
    plantsWithPhotos, plants: Object.keys(manifest.plants).length,
    photoBytes: [...physical.values()].reduce((sum, image) => sum + image.bytes, 0) };
  if (!manifest.counts || Object.entries(counts).some(([key, value]) => manifest.counts[key] !== value))
    throw new Error('Reference-photo manifest counts differ from its associations/files.');
  files.set('photos/NOTICE.txt', { path: 'photos/NOTICE.txt', ...await digest(notice) });
  const selected = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { ...metadata, counts, files: selected, totalBytes: selected.reduce((sum, file) => sum + file.bytes, 0) };
}

export async function verifyPhotos(target, metadata) {
  checkMetadata(metadata);
  const current = await selectPhotos(target, metadata, join(target, 'photos/NOTICE.txt'));
  if (JSON.stringify(current.files) !== JSON.stringify(metadata.files) || current.totalBytes !== metadata.totalBytes ||
      JSON.stringify(current.counts) !== JSON.stringify(metadata.counts)) throw new Error('Photo assets differ from pinned deployment receipts.');
  const allowed = new Set(metadata.files.map(file => file.path));
  async function walk(path) {
    const info = await lstat(join(target, path));
    if (info.isSymbolicLink()) throw new Error(`Photo deployment must not contain symlinks: ${path}`);
    if (info.isDirectory()) for (const child of await readdir(join(target, path))) await walk(`${path}/${child}`);
    else if (!info.isFile() || !allowed.has(path)) throw new Error(`Unselected photo asset would be published: ${path}`);
  }
  await walk('photos');
  return { photosId: metadata.photosId, catalogId: metadata.catalogId, files: metadata.files.length, bytes: metadata.totalBytes, counts: metadata.counts };
}

export async function validatePhotoArchive(archive, metadata) {
  checkMetadata(metadata);
  const actual = await digest(archive);
  if (!metadata.archive || actual.bytes > maxArchiveBytes || actual.bytes !== metadata.archive.bytes || actual.sha256 !== metadata.archive.sha256)
    throw new Error('Photo archive size or SHA-256 does not match the pinned receipt.');
  // Safe generated path list + a fixed buffer bound handle twelve thousand files without ARG_MAX or unbounded output.
  const options = { maxBuffer: maxListingBytes };
  const listing = (await exec('tar', ['-tzf', archive], options)).stdout.trimEnd().split('\n');
  const verbose = (await exec('tar', ['-tvzf', archive], options)).stdout.trimEnd().split('\n');
  const expected = new Set(metadata.files.map(file => file.path));
  if (listing.length !== expected.size || new Set(listing).size !== listing.length ||
      listing.some(path => !expected.has(path)) || verbose.length !== expected.size || verbose.some(line => !line.startsWith('-')))
    throw new Error('Photo archive must contain exactly the pinned regular files, with no links or extra paths.');
}

export async function createPhotoArchive(source, archive, metadata) {
  const selected = await selectPhotos(source, metadata);
  const temporary = `${archive}.partial-${process.pid}`;
  const auxiliary = await mkdtemp(join(tmpdir(), 'plant-photos-create-'));
  try {
    await mkdir(dirname(archive), { recursive: true });
    await mkdir(join(auxiliary, 'photos'));
    await copyFile(join(source, 'third-party-notices.txt'), join(auxiliary, 'photos/NOTICE.txt'));
    const list = join(auxiliary, 'files.txt');
    // BSD tar requires -C and its directory on separate lines; GNU tar documents -C<directory>.
    const bsdTar = (await exec('tar', ['--version'])).stdout.includes('bsdtar');
    await writeFile(list, [...(bsdTar ? ['-C', resolve(source)] : [`-C${resolve(source)}`]),
      ...selected.files.filter(file => file.path !== 'photos/NOTICE.txt').map(file => file.path),
      ...(bsdTar ? ['-C', auxiliary] : [`-C${auxiliary}`]), 'photos/NOTICE.txt'].join('\n') + '\n');
    await exec('tar', ['--format=ustar', '-czf', temporary, '-T', list]);
    selected.archive = { ...metadata.archive, ...await digest(temporary) };
    await validatePhotoArchive(temporary, selected);
    await rename(temporary, archive);
    return selected;
  } finally {
    await rm(temporary, { force: true });
    await rm(auxiliary, { recursive: true, force: true });
  }
}

export async function restorePhotos(archive, target, metadata) {
  await validatePhotoArchive(archive, metadata); // Authenticate before extracting anything.
  for (const path of ['photos.json', 'photos']) {
    try { await lstat(join(target, path)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Photo restore preserves existing ${path}; use a target without a photo namespace.`);
  }
  const staging = await mkdtemp(join(tmpdir(), 'plant-photos-restore-'));
  try {
    await exec('tar', ['-xzf', archive, '-C', staging, '--no-same-owner', '--no-same-permissions']);
    await verifyPhotos(staging, metadata);
    await mkdir(target, { recursive: true });
    // Copy first, publish pointer last. Core catalog/model/runtime files are outside this namespace.
    for (const file of metadata.files.filter(file => file.path !== 'photos.json')) {
      await mkdir(dirname(join(target, file.path)), { recursive: true });
      await copyFile(join(staging, file.path), join(target, file.path));
    }
    await copyFile(join(staging, 'photos.json'), join(target, 'photos.json'));
    return await verifyPhotos(target, metadata);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function checkSiteSize(target) {
  let bytes = 0;
  async function walk(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Published site must not contain symlinks.');
    if (info.isDirectory()) for (const entry of await readdir(path)) await walk(join(path, entry));
    else if (info.isFile()) bytes += info.size;
    else throw new Error('Published site must contain only regular files.');
  }
  await walk(target);
  if (bytes >= 1_000_000_000) throw new Error(`Published site exceeds the 1 GB budget: ${bytes} bytes.`);
  return { bytes, below950MB: bytes < 950_000_000 };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  if (args.length % 2) throw new Error('Expected option/value pairs.');
  for (let index = 0; index < args.length; index += 2) {
    if (!['--source', '--target', '--archive', '--metadata'].includes(args[index]) || options[args[index]]) throw new Error('Unknown or duplicate option.');
    options[args[index]] = args[index + 1];
  }
  const target = resolve(options['--target'] ?? 'public');
  if (command === 'check-size') { console.log(JSON.stringify(await checkSiteSize(target))); return; }
  const metadataFile = resolve(options['--metadata'] ?? 'deployment/photos.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  if (command === 'create') {
    const selected = await createPhotoArchive(resolve(options['--source'] ?? 'public'),
      resolve(options['--archive'] ?? '.cache/photos-assets.tar.gz'), metadata);
    await writeFile(metadataFile, JSON.stringify(selected, null, 2) + '\n');
    console.log(JSON.stringify({ photosId: selected.photosId, files: selected.files.length, bytes: selected.totalBytes, counts: selected.counts, archive: selected.archive }));
  } else if (command === 'verify') console.log(JSON.stringify(await verifyPhotos(target, metadata)));
  else if (command === 'restore') {
    if (options['--archive']) console.log(JSON.stringify(await restorePhotos(resolve(options['--archive']), target, metadata)));
    else {
      if (!metadata.archive || !/^https:\/\/github\.com\/saulshanabrook\/plant-friends\/releases\/download\/[^/]+\/[^/]+$/.test(metadata.archive.url) ||
          !Number.isSafeInteger(metadata.archive.bytes) || metadata.archive.bytes < 1 || metadata.archive.bytes > maxArchiveBytes || !hashPattern.test(metadata.archive.sha256))
        throw new Error('Pin the public photo release URL, size, and SHA-256 first.');
      const staging = await mkdtemp(join(tmpdir(), 'plant-photos-download-'));
      try {
        const archive = join(staging, 'photos.tar.gz');
        const response = await fetch(metadata.archive.url);
        if (!response.ok || !response.body) throw new Error(`Photo release download failed: HTTP ${response.status}`);
        let received = 0;
        const limit = new Transform({ transform(chunk, encoding, callback) {
          received += chunk.length;
          callback(received > metadata.archive.bytes ? new Error('Photo release exceeds its pinned size.') : null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(archive));
        console.log(JSON.stringify(await restorePhotos(archive, target, metadata)));
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
  } else throw new Error('Expected create, restore, verify, or check-size.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
