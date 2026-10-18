import { sha256 } from '@noble/hashes/sha2.js';
import type { InstalledPack } from './storage';
import { catalogIndex } from './source';

export interface PlantPhoto { url: string; sha256: string; bytes: number; width: number; height: number; sourceUrl: string; credit: string | null }
export interface PhotoProgress { received: number; total: number; completed: number; totalFiles: number }
export interface PhotoAlbum { photosByPlant: Record<string, PlantPhoto[]>; files: PlantPhoto[] }
export const PHOTO_CACHE = 'plant-friends-photos-v1';
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const BASE = import.meta.env.BASE_URL;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hash = (bytes: Uint8Array): string => Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

/** Confine both native-image and metadata requests to the app's photo namespace. */
function photoLocation(address: string): { url: URL; kind: 'pointer' | 'manifest' | 'image'; id?: string; sha256?: string } {
  let url: URL;
  try { url = new URL(address); } catch { throw new Error('The reference photo address is invalid.'); }
  if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Reference photos must be hosted in this app.');
  if (url.pathname === `${BASE}photos.json`) return { url, kind: 'pointer' };
  const path = url.pathname.slice(BASE.length);
  if (!url.pathname.startsWith(BASE)) throw new Error('Reference photos must be hosted in this app.');
  const manifest = /^photos\/([A-Za-z0-9_-]{1,128})\/manifest\.json$/.exec(path);
  if (manifest) return { url, kind: 'manifest', id: manifest[1] };
  const image = /^photos\/([A-Za-z0-9_-]{1,128})\/files\/([a-f0-9]{64})\.webp$/.exec(path);
  if (image) return { url, kind: 'image', id: image[1], sha256: image[2] };
  throw new Error('The reference photo path is invalid.');
}

export function handlesPhotoRequest(address: string): boolean {
  const url = new URL(address);
  return url.origin === location.origin && (url.pathname === `${BASE}photos.json` || url.pathname.startsWith(`${BASE}photos/`));
}

export function validatePhotoManifest(value: unknown, manifestUrl: string, catalogId: string, plantIds: ReadonlySet<string>): PhotoAlbum {
  const address = photoLocation(manifestUrl);
  if (address.kind !== 'manifest' || !object(value) || value.schemaVersion !== 1 || value.id !== address.id || value.catalogId !== catalogId ||
      !object(value.source) || typeof value.source.repository !== 'string' || !value.source.repository.trim() ||
      typeof value.source.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.source.commit) || !digest(value.source.databaseSha256) ||
      !object(value.images) || !object(value.plants)) throw new Error('The reference photo index does not match this catalog or its source metadata.');
  const images = new Map<string, Omit<PlantPhoto, 'credit'>>();
  const physical = new Map<string, PlantPhoto>();
  for (const [id, image] of Object.entries(value.images)) {
    if (!digest(id) || !object(image) || !digest(image.sha256) || image.url !== `files/${image.sha256}.webp` ||
        !Number.isSafeInteger(image.bytes) || (image.bytes as number) < 1 || (image.bytes as number) > MAX_PHOTO_BYTES ||
        !Number.isInteger(image.width) || !Number.isInteger(image.height) || (image.width as number) < 1 || (image.height as number) < 1 ||
        (image.width as number) > 640 || (image.height as number) > 640 || !digest(image.originalSha256) || typeof image.originalUrl !== 'string')
      throw new Error('A reference photo has invalid size, dimensions, path, or integrity metadata.');
    let source: URL;
    try { source = new URL(image.originalUrl); } catch { throw new Error('A reference photo source address is invalid.'); }
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password ||
        hash(new TextEncoder().encode(image.originalUrl)) !== id) throw new Error('A reference photo source does not match its identifier.');
    const normalized = { url: new URL(image.url, manifestUrl).href, sha256: image.sha256, bytes: image.bytes as number,
      width: image.width as number, height: image.height as number, sourceUrl: image.originalUrl };
    const previous = physical.get(normalized.url);
    if (previous && (previous.bytes !== normalized.bytes || previous.width !== normalized.width || previous.height !== normalized.height))
      throw new Error('Shared reference photo metadata is inconsistent.');
    images.set(id, normalized);
    physical.set(normalized.url, { ...normalized, credit: null });
  }
  const photosByPlant: Record<string, PlantPhoto[]> = Object.create(null);
  const referenced = new Set<string>();
  for (const [id, associations] of Object.entries(value.plants)) {
    if (!plantIds.has(id) || !Array.isArray(associations)) throw new Error('A reference photo association has no matching catalog plant.');
    photosByPlant[id] = associations.map(association => {
      if (!object(association) || typeof association.photoId !== 'string' || !images.has(association.photoId) ||
          (association.credit !== null && typeof association.credit !== 'string')) throw new Error('A reference photo association or credit is invalid.');
      referenced.add(association.photoId);
      return { ...images.get(association.photoId)!, credit: association.credit as string | null };
    });
  }
  if (Object.keys(photosByPlant).length !== plantIds.size || referenced.size !== images.size) throw new Error('The reference photo index omits catalog plants or image associations.');
  return { photosByPlant, files: [...physical.values()] };
}

/** Bound allocation and each transport stall, and classify transport errors only. */
async function fetchBytes(url: string, limit: number, signal: AbortSignal, expectedBytes?: number, network?: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const controller = new AbortController();
  async function transport<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); controller.abort(); reject(new DOMException('Reference photo download stopped.', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); controller.abort(); reject(new DOMException('Reference photo download stalled. It will resume when connected.', 'TimeoutError')); }, 30_000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      Promise.resolve().then(operation).then(value => { cleanup(); resolve(value); }, cause => {
        cleanup(); reject(signal.aborted ? new DOMException('Reference photo download stopped.', 'AbortError') :
          new DOMException(`Reference photos could not be reached. Saved photos are kept. ${cause instanceof Error ? cause.message : ''}`, 'NetworkError'));
      });
    });
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await transport(() => fetch(url, { signal: controller.signal, cache: 'no-store', mode: 'same-origin', redirect: 'manual' }));
    if (response.status !== 200 || response.type === 'opaque' || !response.body ||
        response.redirected && response.url !== url) {
      await response.body?.cancel();
      throw new Error(`Reference photos are unavailable (HTTP ${response.status}). Reload after the host is repaired.`);
    }
    const length = response.headers.get('Content-Length');
    const encoded = response.headers.get('Content-Encoding');
    if (length !== null && (!/^\d+$/.test(length) || (!encoded || encoded === 'identity') &&
        (Number(length) > limit || expectedBytes !== undefined && Number(length) !== expectedBytes))) {
      await response.body.cancel(); throw new Error('Reference photo download size is invalid.');
    }
    reader = response.body.getReader();
    const bytes = new Uint8Array(expectedBytes ?? limit);
    let received = 0;
    while (true) {
      const part = await transport(() => reader!.read());
      if (part.done) break;
      if (received + part.value.byteLength > bytes.length) throw new Error('Reference photo download exceeded its bounded size.');
      bytes.set(part.value, received); received += part.value.byteLength;
      network?.(part.value.byteLength);
    }
    signal.throwIfAborted();
    if (!received || expectedBytes !== undefined && received !== expectedBytes) throw new Error('Reference photo download has an incorrect size.');
    return received === bytes.length ? bytes : bytes.slice(0, received);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

async function cachedBytes(cache: Cache, url: string, limit: number, expected?: { bytes: number; sha256: string }): Promise<Uint8Array<ArrayBuffer>> {
  const response = await cache.match(url);
  if (!response) throw new Error('The reference photo index has not been saved for offline use.');
  const length = Number(response.headers.get('Content-Length'));
  const expectedHash = expected?.sha256 ?? response.headers.get('X-Plant-Friends-Photo-Sha256');
  if (!Number.isSafeInteger(length) || length < 1 || length > limit || !digest(expectedHash) || expected && length !== expected.bytes) {
    await response.body?.cancel(); throw new Error('Saved reference photo metadata is invalid.');
  }
  // Metadata is small/bounded; image bodies are never read by startup inventory.
  if (!response.body) throw new Error('Saved reference photo metadata is empty.');
  const reader = response.body.getReader(), bytes = new Uint8Array(length);
  let received = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (received + part.value.byteLength > length) throw new Error('Saved reference photo metadata exceeded its bounded size.');
      bytes.set(part.value, received); received += part.value.byteLength;
    }
    if (received !== length || hash(bytes) !== expectedHash) throw new Error('Saved reference photo metadata failed its integrity check.');
    return bytes;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function loadPhotoAlbum(catalog: InstalledPack, signal: AbortSignal, network?: (bytes: number) => void): Promise<PhotoAlbum> {
  if (catalog.manifest.kind !== 'pfaf') throw new Error('Reference photos require the installed PFAF catalog.');
  const ids = new Set((await catalogIndex(catalog)).map(entry => entry.id));
  signal.throwIfAborted();
  const pointerUrl = new URL(`${BASE}photos.json`, location.origin).href;
  const cache = await caches.open(PHOTO_CACHE);
  async function load(saved: boolean): Promise<PhotoAlbum> {
    const pointerBytes = saved ? await cachedBytes(cache, pointerUrl, 64 * 1024) : await fetchBytes(pointerUrl, 64 * 1024, signal, undefined, network);
    const pointer: unknown = JSON.parse(new TextDecoder().decode(pointerBytes));
    if (!object(pointer) || typeof pointer.url !== 'string' || !/^photos\/[A-Za-z0-9_-]{1,128}\/manifest\.json$/.test(pointer.url) ||
        !digest(pointer.sha256) || !Number.isSafeInteger(pointer.bytes) || (pointer.bytes as number) < 1 || (pointer.bytes as number) > MAX_MANIFEST_BYTES)
      throw new Error('The reference photo pointer is invalid.');
    const manifestUrl = new URL(pointer.url, pointerUrl).href;
    const descriptor = { bytes: pointer.bytes as number, sha256: pointer.sha256 };
    const bytes = saved ? await cachedBytes(cache, manifestUrl, MAX_MANIFEST_BYTES, descriptor) : await fetchBytes(manifestUrl, MAX_MANIFEST_BYTES, signal, descriptor.bytes, network);
    if (hash(bytes) !== descriptor.sha256) throw new Error('The reference photo index failed its integrity check.');
    const album = validatePhotoManifest(JSON.parse(new TextDecoder().decode(bytes)), manifestUrl, catalog.manifest.id, ids);
    signal.throwIfAborted();
    if (!saved) {
      await cache.put(manifestUrl, new Response(bytes, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length), 'X-Plant-Friends-Photo-Sha256': descriptor.sha256 } }));
      signal.throwIfAborted();
      await cache.put(pointerUrl, new Response(pointerBytes, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(pointerBytes.length), 'X-Plant-Friends-Photo-Sha256': hash(pointerBytes) } }));
    }
    return album;
  }
  if (!navigator.onLine) return load(true);
  try { return await load(false); }
  catch (error) {
    if (signal.aborted) throw error;
    try { return await load(true); } catch { throw error; }
  }
}

export async function cachePlantPhoto(photo: PlantPhoto | string, signal: AbortSignal = new AbortController().signal, network?: (bytes: number) => void): Promise<Response> {
  const address = photoLocation(typeof photo === 'string' ? photo : photo.url);
  if (address.kind !== 'image' || typeof photo !== 'string' && (photo.sha256 !== address.sha256 || !Number.isSafeInteger(photo.bytes) || photo.bytes < 1 || photo.bytes > MAX_PHOTO_BYTES))
    throw new Error('The reference photo integrity metadata is invalid.');
  const expected = typeof photo === 'string' ? undefined : photo;
  const save = async () => {
    signal.throwIfAborted();
    const cache = await caches.open(PHOTO_CACHE);
    // The content-addressed key also deduplicates later album versions.
    const key = new URL(`${BASE}__plant-friends-photo__/${address.sha256}.webp`, location.origin);
    const cached = await cache.match(key);
    if (cached) {
      const length = Number(cached.headers.get('Content-Length'));
      if (cached.headers.get('X-Plant-Friends-Photo-Sha256') === address.sha256 && Number.isSafeInteger(length) && length > 0 && length <= MAX_PHOTO_BYTES &&
          (!expected || expected.bytes === length)) return cached;
      await cached.body?.cancel(); await cache.delete(key);
    }
    if (!navigator.onLine) throw new DOMException('Connect to save the remaining reference photos.', 'NetworkError');
    const bytes = await fetchBytes(address.url.href, MAX_PHOTO_BYTES, signal, expected?.bytes, network);
    if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF' || new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WEBP' ||
        new DataView(bytes.buffer).getUint32(4, true) + 8 !== bytes.length || hash(bytes) !== address.sha256)
      throw new Error('A reference photo failed its WebP or integrity check.');
    signal.throwIfAborted();
    const headers = { 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length), 'X-Plant-Friends-Photo-Sha256': address.sha256! };
    await cache.put(key, new Response(bytes, { headers }));
    return new Response(bytes, { headers });
  };
  try {
    return navigator.locks ? await navigator.locks.request(`plant-friends-photo:${address.sha256}`, { signal }, save) : await save();
  } catch (error) {
    if (signal.aborted) throw new DOMException('Reference photo download stopped.', 'AbortError');
    if (error instanceof DOMException && ['QuotaExceededError', 'UnknownError', 'SecurityError', 'NotSupportedError'].includes(error.name))
      throw new Error('Reference photos could not be saved. Allow site storage or free browser space, then reload.', { cause: error });
    throw error;
  }
}

/** One key inventory supplies both accurate saved progress and the pending queue.
 * Only verified atomic image writes use these content-addressed keys. */
export async function photoInventory(album: PhotoAlbum): Promise<{ pending: PlantPhoto[]; progress: PhotoProgress }> {
  const cache = await caches.open(PHOTO_CACHE);
  const inventory = new Set((await cache.keys()).map(request => request.url));
  const pending: PlantPhoto[] = [];
  const progress = { received: 0, total: 0, completed: 0, totalFiles: album.files.length };
  for (const photo of album.files) {
    progress.total += photo.bytes;
    if (inventory.has(new URL(`${BASE}__plant-friends-photo__/${photo.sha256}.webp`, location.origin).href)) {
      progress.received += photo.bytes; progress.completed++;
    } else pending.push(photo);
  }
  return { pending, progress };
}

export async function cachePhotoAlbum(album: PhotoAlbum, signal: AbortSignal, progress: (value: PhotoProgress) => void, network?: (bytes: number) => void): Promise<void> {
  const { pending, progress: value } = await photoInventory(album);
  signal.throwIfAborted(); progress({ ...value });
  const failed = new AbortController();
  const combined = AbortSignal.any([signal, failed.signal]);
  let next = 0, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, async () => {
    try {
      while (next < pending.length) {
        combined.throwIfAborted();
        const photo = pending[next++];
        const response = await cachePlantPhoto(photo, combined, network);
        await response.body?.cancel();
        combined.throwIfAborted();
        value.received += photo.bytes; value.completed++;
        progress({ ...value });
      }
    } catch (error) { if (failure === undefined) { failure = error; failed.abort(); } }
  }));
  signal.throwIfAborted();
  if (failure !== undefined) throw failure;
}

/** Native images share the same verified per-image writer as the bulk queue. */
export async function photoResponse(request: Request): Promise<Response> {
  const address = photoLocation(request.url);
  if (address.kind === 'image') return cachePlantPhoto(address.url.href, request.signal);
  const cached = await (await caches.open(PHOTO_CACHE)).match(address.url);
  if (cached) return cached;
  return fetch(request, { mode: 'same-origin', redirect: 'error' });
}
