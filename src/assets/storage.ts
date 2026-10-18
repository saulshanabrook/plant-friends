import { sha256 } from '@noble/hashes/sha2.js';
import type { AssetFile, CatalogManifest, ModelManifest, PackManifest } from './manifest';
import { validateManifest, validateCatalogIndex, validateCatalogDetails, validateVectors } from './manifest';

export const ASSET_CACHE = 'plant-friends-packs-v2';
export interface InstalledPack { manifestUrl: string; manifest: PackManifest; installedAt: string; persistent: boolean }
export interface DownloadProgress { received: number; total: number; file: string; phase?: 'checking' | 'downloading' | 'verifying' }
const CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_FORMAT = 'chunks-v1';
const STALL_TIMEOUT_MS = 30_000;

function assetLocations(manifestUrl: string, file: AssetFile) {
  const complete = new URL(`/__plant-friends-verified__/${file.sha256}/${file.bytes}`, manifestUrl);
  const chunks = [];
  if (file.bytes > CHUNK_BYTES) for (let start = 0; start < file.bytes; start += CHUNK_BYTES) {
    chunks.push({ start, bytes: Math.min(CHUNK_BYTES, file.bytes - start),
      key: new URL(`/__plant-friends-chunk__/${file.sha256}/${file.bytes}/${CHUNK_BYTES}/${start}`, manifestUrl) });
  }
  return { complete, chunks };
}

function validChunk(response: Response, file: AssetFile, start: number, bytes: number): boolean {
  return response.headers.get('X-Plant-Friends-Sha256') === file.sha256 &&
    response.headers.get('X-Plant-Friends-Offset') === String(start) &&
    response.headers.get('Content-Length') === String(bytes) &&
    /^[0-9a-f]{64}$/.test(response.headers.get('X-Plant-Friends-Chunk-Sha256') ?? '');
}

/** Only a final full-file hash creates this descriptor. Partial chunks alone
 * never satisfy readAsset/installedPack, and no whole-file copy is assembled. */
async function cachedAsset(cache: Cache, manifestUrl: string, file: AssetFile): Promise<Response | undefined> {
  const { complete, chunks } = assetLocations(manifestUrl, file);
  const response = await cache.match(complete);
  if (!response) return;
  if (response.headers.get('X-Plant-Friends-Storage') !== CHUNK_FORMAT) {
    if (response.headers.get('X-Plant-Friends-Sha256') === file.sha256 && response.headers.get('Content-Length') === String(file.bytes)) return response;
    await response.body?.cancel();
    return;
  }
  const valid = chunks.length > 0 && response.headers.get('X-Plant-Friends-Sha256') === file.sha256 &&
    response.headers.get('X-Plant-Friends-Bytes') === String(file.bytes) && response.headers.get('X-Plant-Friends-Chunk-Size') === String(CHUNK_BYTES);
  await response.body?.cancel();
  if (!valid) return;
  for (const chunk of chunks) {
    const part = await cache.match(chunk.key);
    const present = part && validChunk(part, file, chunk.start, chunk.bytes);
    await part?.body?.cancel();
    if (!present) return;
  }
  let index = 0, bytes = 0, canceled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (index < chunks.length) {
          const chunk = chunks[index];
          if (!reader) {
            const part = await cache.match(chunk.key);
            if (canceled) { await part?.body?.cancel(); return; }
            if (!part?.body || !validChunk(part, file, chunk.start, chunk.bytes)) {
              await part?.body?.cancel();
              throw new Error('An offline file is missing or was evicted. Reinstall the downloaded pack.');
            }
            reader = part.body.getReader();
            bytes = 0;
          }
          const part = await reader.read();
          if (canceled) return;
          if (part.done) {
            reader.releaseLock(); reader = undefined;
            if (bytes !== chunk.bytes) throw new Error('An offline chunk has an incorrect size. Reinstall the downloaded pack.');
            index++;
          } else {
            bytes += part.value.byteLength;
            if (bytes > chunk.bytes) throw new Error('An offline chunk has an incorrect size. Reinstall the downloaded pack.');
            controller.enqueue(part.value);
            return;
          }
        }
        controller.close();
      } catch (error) { await reader?.cancel().catch(() => undefined); controller.error(error); }
    },
    async cancel(reason) { canceled = true; await reader?.cancel(reason); },
  }, { highWaterMark: 0 }), { headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
    'Content-Length': String(file.bytes), 'X-Plant-Friends-Sha256': file.sha256 } });
}

/** A fresh deadline covers each fetch/read stall, not the whole installation.
 * Only transport failures get recoverable names; validation/storage errors do not. */
async function networkResponse(url: string, manifestUrl: string, signal: AbortSignal, range?: string): Promise<Response> {
  signal.throwIfAborted();
  const controller = new AbortController();
  async function transport<T>(action: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const abort = () => {
        cleanup(); controller.abort();
        reject(new DOMException('Download canceled. You can retry when ready.', 'AbortError'));
      };
      const timer = setTimeout(() => {
        cleanup(); controller.abort();
        reject(new DOMException('The download stalled. Check the connection and retry; saved chunks are kept.', 'TimeoutError'));
      }, STALL_TIMEOUT_MS);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      Promise.resolve().then(action).then(value => { cleanup(); resolve(value); }, cause => {
        cleanup();
        reject(signal.aborted ? new DOMException('Download canceled.', 'AbortError') :
          new DOMException(`Could not download ${url}. Check the connection and retry; saved chunks are kept. ${cause instanceof Error ? cause.message : ''}`, 'NetworkError'));
      });
    });
  }
  const response = await transport(() => fetch(url, { signal: controller.signal, cache: 'no-store', ...(range ? { headers: { Range: range } } : {}) }));
  if (!response.ok || response.type === 'opaque' || !response.body) {
    await response.body?.cancel();
    throw new Error(`Could not download ${url} (HTTP ${response.status}). Check the connection and retry.`);
  }
  if (response.redirected && new URL(response.url).origin !== new URL(manifestUrl).origin) {
    await response.body.cancel();
    throw new Error(`The download for ${url} left this site. Refresh and retry.`);
  }
  const reader = response.body.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const part = await transport(() => reader.read());
        if (part.done) { reader.releaseLock(); stream.close(); }
        else stream.enqueue(part.value);
      } catch (error) { controller.abort(); void reader.cancel().catch(() => undefined); stream.error(error); }
    },
    async cancel(reason) { controller.abort(); await reader.cancel(reason); },
  }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
}

async function boundedChunk(response: Response, bytes: number, signal: AbortSignal, progress: (received: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error('The download was empty. Retry the download.');
  const reader = response.body.getReader();
  const result = new Uint8Array(bytes);
  let received = 0, done = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) { done = true; break; }
      if (received + part.value.byteLength > bytes) throw new Error('The download size changed. Refresh and retry.');
      result.set(part.value, received); received += part.value.byteLength;
      progress(received);
    }
    if (received !== bytes) throw new Error('Integrity check failed: the downloaded chunk has an incorrect size. Retry the download.');
    return result;
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function downloadChunks(cache: Cache, manifestUrl: string, file: AssetFile, signal: AbortSignal,
  progress: (received: number, phase: DownloadProgress['phase']) => void): Promise<void> {
  const { complete, chunks } = assetLocations(manifestUrl, file);
  const fullHash = sha256.create();
  let contentType = 'application/octet-stream';
  for (const chunk of chunks) {
    signal.throwIfAborted();
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    const cached = await cache.match(chunk.key);
    if (cached) {
      try {
        if (!validChunk(cached, file, chunk.start, chunk.bytes)) throw new Error('Invalid saved chunk metadata.');
        bytes = await boundedChunk(cached, chunk.bytes, signal, received => progress(chunk.start + received, 'checking'));
        if (Array.from(sha256(bytes), value => value.toString(16).padStart(2, '0')).join('') !== cached.headers.get('X-Plant-Friends-Chunk-Sha256'))
          throw new Error('Invalid saved chunk hash.');
        contentType = cached.headers.get('Content-Type') ?? 'application/octet-stream';
      } catch (error) {
        await cached.body?.cancel().catch(() => undefined);
        if (signal.aborted) throw error;
        bytes = undefined;
        await cache.delete(chunk.key);
      }
    }
    if (!bytes) {
      progress(chunk.start, 'downloading');
      const response = await networkResponse(new URL(file.url, manifestUrl).href, manifestUrl, signal,
        `bytes=${chunk.start}-${chunk.start + chunk.bytes - 1}`);
      if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${chunk.start}-${chunk.start + chunk.bytes - 1}/${file.bytes}` ||
          (response.headers.has('Content-Length') && response.headers.get('Content-Length') !== String(chunk.bytes))) {
        await response.body?.cancel();
        throw new Error(response.status === 200 ?
          'This server did not honor byte-range downloads. Saved chunks are kept; use a host with HTTP Range support and retry.' :
          'The server returned an incorrect download range or size. Refresh and retry.');
      }
      bytes = await boundedChunk(response, chunk.bytes, signal, received => progress(chunk.start + received, 'downloading'));
      signal.throwIfAborted();
      contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
      await cache.put(chunk.key, new Response(bytes, { headers: {
        'Content-Type': contentType,
        'Content-Length': String(chunk.bytes), 'X-Plant-Friends-Sha256': file.sha256,
        'X-Plant-Friends-Offset': String(chunk.start),
        'X-Plant-Friends-Chunk-Sha256': Array.from(sha256(bytes), value => value.toString(16).padStart(2, '0')).join(''),
      } }));
    }
    fullHash.update(bytes);
  }
  progress(file.bytes, 'verifying');
  signal.throwIfAborted();
  if (Array.from(fullHash.digest(), value => value.toString(16).padStart(2, '0')).join('') !== file.sha256) {
    for (const chunk of chunks) await cache.delete(chunk.key);
    await cache.delete(complete);
    throw new Error(`Integrity check failed for ${file.url}. Retry the download.`);
  }
  await cache.put(complete, new Response(null, { headers: {
    'Content-Type': contentType,
    'X-Plant-Friends-Storage': CHUNK_FORMAT, 'X-Plant-Friends-Sha256': file.sha256,
    'X-Plant-Friends-Bytes': String(file.bytes), 'X-Plant-Friends-Chunk-Size': String(CHUNK_BYTES),
  } }));
}

async function receiptStore(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open('plant-friends', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('packs');
    request.onerror = () => reject(new Error('Browser offline storage could not be opened. Allow site storage and retry.', { cause: request.error }));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Offline storage is busy in another tab. Close other Plant Friends tabs and retry.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      try {
        const transaction = db.transaction('packs', mode);
        const operation = action(transaction.objectStore('packs'));
        transaction.oncomplete = () => { db.close(); resolve(operation.result); };
        transaction.onerror = transaction.onabort = () => {
          db.close();
          reject(new Error('Offline installation could not be saved. Free browser storage and retry.', { cause: transaction.error }));
        };
      } catch (error) { db.close(); reject(error); }
    };
  });
}

async function discardReceipt(kind: PackManifest['kind'], expected: InstalledPack): Promise<void> {
  await receiptStore('readwrite', store => {
    const request = store.get(kind);
    // A status check can overlap activation. Never delete a newer receipt just
    // because the earlier pack was evicted while this check was in flight.
    request.onsuccess = () => {
      if (JSON.stringify(request.result) === JSON.stringify(expected)) store.delete(kind);
    };
    return request;
  });
}

async function pruneUnreferenced(): Promise<void> {
  const retained = new Set<string>();
  const cache = await caches.open(ASSET_CACHE);
  const receipts = await receiptStore('readonly', store => store.getAll()) as (InstalledPack & { pending?: boolean })[];
  for (const receipt of receipts) {
    try { validateManifest(receipt.manifest, receipt.manifestUrl); }
    catch { continue; }
    for (const file of receipt.manifest.files) {
      const { complete, chunks } = assetLocations(receipt.manifestUrl, file);
      retained.add(complete.href);
      if (!chunks.length) continue;
      const response = await cache.match(complete);
      if (receipt.pending || response?.headers.get('X-Plant-Friends-Storage') === CHUNK_FORMAT)
        for (const chunk of chunks) retained.add(chunk.key.href);
      await response?.body?.cancel();
    }
  }
  for (const request of await cache.keys()) if (!retained.has(request.url)) await cache.delete(request);
}

export async function installedPack(kind: PackManifest['kind']): Promise<InstalledPack | null> {
  const receipt = await receiptStore('readonly', store => store.get(kind)) as InstalledPack | undefined;
  if (!receipt) return null;
  try {
    validateManifest(receipt.manifest, receipt.manifestUrl);
    if (receipt.manifest.kind !== kind) throw new Error('Wrong offline pack receipt.');
  } catch {
    await discardReceipt(kind, receipt);
    return null;
  }
  const cache = await caches.open(ASSET_CACHE);
  for (const file of receipt.manifest.files) {
    const response = await cachedAsset(cache, receipt.manifestUrl, file);
    if (!response) {
      await discardReceipt(kind, receipt);
      return null;
    }
    await response.body?.cancel();
  }
  return receipt;
}

export async function readAsset(pack: InstalledPack, file: AssetFile): Promise<Response> {
  if (!pack.manifest.files.some(asset => asset.url === file.url && asset.bytes === file.bytes && asset.sha256 === file.sha256))
    throw new Error('This file does not belong to the installed offline pack. Reinstall a matching pack.');
  const response = await cachedAsset(await caches.open(ASSET_CACHE), pack.manifestUrl, file);
  if (!response) {
    throw new Error('An offline file is missing or was evicted. Reinstall the downloaded pack.');
  }
  return response;
}

async function verifyPackContents(pack: InstalledPack, signal: AbortSignal): Promise<void> {
  const manifest = pack.manifest;
  if (manifest.kind === 'pfaf') {
    const indexFile = manifest.files.find(file => file.url === manifest.indexFile)!;
    let indexValue: unknown;
    try { indexValue = await (await readAsset(pack, indexFile)).json(); }
    catch (error) { throw new Error('The catalog index could not be read. Rebuild or reinstall the catalog.', { cause: error }); }
    const index = validateCatalogIndex(indexValue, manifest);
    for (const file of manifest.files) {
      signal.throwIfAborted();
      if (file.url === manifest.indexFile) continue;
      let value: unknown;
      try { value = await (await readAsset(pack, file)).json(); }
      catch (error) { throw new Error(`Catalog details in ${file.url} could not be read. Rebuild or reinstall the catalog.`, { cause: error }); }
      validateCatalogDetails(value, index, file.url);
    }
  } else {
    const catalog = await matchingCatalog(manifest);
    const indexFile = catalog.manifest.files.find(file => file.url === catalog.manifest.indexFile)!;
    let rows: unknown, indexValue: unknown;
    try {
      rows = await (await readAsset(pack, manifest.catalog.rows)).json();
      indexValue = await (await readAsset(catalog, indexFile)).json();
    } catch (error) { throw new Error('Identification rows or the catalog index are malformed. Rebuild or reinstall a matching pack.', { cause: error }); }
    const index = validateCatalogIndex(indexValue, catalog.manifest);
    const vectors = new Float32Array(await (await readAsset(pack, manifest.vectors.file)).arrayBuffer());
    validateVectors(vectors, rows, manifest, catalog.manifest, index);
  }
}

async function matchingCatalog(manifest: ModelManifest): Promise<InstalledPack & { manifest: CatalogManifest }> {
  const catalog = await installedPack('pfaf');
  if (!catalog || catalog.manifest.kind !== 'pfaf' || catalog.manifest.id !== manifest.catalog.id ||
      catalog.manifest.sourceSha256 !== manifest.catalog.sourceSha256 || catalog.manifest.taxonCount !== manifest.catalog.fullTaxonCount)
    throw new Error('Install the matching PFAF catalog before installing this identification pack.');
  return { ...catalog, manifest: catalog.manifest };
}

// Web Locks serialize activation/deletion across tabs and workers. The queue
// keeps those operations serialized within one context on older browsers.
let storageMutation: Promise<unknown> = Promise.resolve();
async function mutateStorage<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request('plant-friends-pack-storage', { mode: 'exclusive', ...(signal ? { signal } : {}) }, action);
  const operation = storageMutation.catch(() => undefined).then(() => { signal?.throwIfAborted(); return action(); });
  storageMutation = operation;
  return operation;
}

/** Consume one chunk at a time, without cloning/teeing a model-sized response.
 * A successful Cache.put therefore only exposes bytes after EOF validation.
 */
function verifiedStream(response: Response, file: AssetFile, signal: AbortSignal, chunk: (bytes: number) => void,
  failure: (error: unknown) => void = () => undefined): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error(`The download for ${file.url} was empty. Retry the download.`);
  const reader = response.body.getReader();
  const hash = sha256.create();
  let bytes = 0;
  let closed = false;
  let abort: () => void;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (closed) return;
        closed = true;
        controller.error(new DOMException('Download canceled. You can retry when ready.', 'AbortError'));
        void reader.cancel().catch(() => undefined);
        signal.removeEventListener('abort', abort);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const part = await reader.read();
        signal.throwIfAborted();
        if (closed) return;
        if (part.done) {
          const digest = Array.from(hash.digest(), value => value.toString(16).padStart(2, '0')).join('');
          if (bytes !== file.bytes || digest !== file.sha256)
            throw new Error(`Integrity check failed for ${file.url}. Retry the download.`);
          closed = true;
          signal.removeEventListener('abort', abort);
          reader.releaseLock();
          controller.close();
        } else {
          bytes += part.value.byteLength;
          if (bytes > file.bytes) throw new Error(`The download size changed for ${file.url}. Refresh and retry.`);
          hash.update(part.value);
          chunk(part.value.byteLength);
          controller.enqueue(part.value);
        }
      } catch (error) {
        if (closed) return;
        closed = true;
        failure(error);
        signal.removeEventListener('abort', abort);
        void reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      closed = true;
      signal.removeEventListener('abort', abort);
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

export async function installPack(manifestUrl: string, manifest: PackManifest, signal: AbortSignal, progress: (value: DownloadProgress) => void): Promise<InstalledPack> {
  validateManifest(manifest, manifestUrl);
  manifest = structuredClone(manifest);
  manifestUrl = new URL(manifestUrl).href;
  if (signal.aborted) throw new DOMException('Download canceled. You can retry when ready.', 'AbortError');
  try {
    return await mutateStorage(signal, async () => {
      const cache = await caches.open(ASSET_CACHE);
      if (manifest.kind === 'bioclip2') await matchingCatalog(manifest);
      await receiptStore('readwrite', store => store.put({ manifestUrl, manifest, pending: true }, `pending:${manifest.kind}`));
      await pruneUnreferenced().catch(() => undefined);
      const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
      let received = 0;
      for (const file of manifest.files) {
        signal.throwIfAborted();
        const { complete: key, chunks } = assetLocations(manifestUrl, file);
        const base = received;
        progress({ received, total, file: file.url, phase: 'checking' });
        signal.throwIfAborted();
        const cached = await cachedAsset(cache, manifestUrl, file);
        if (cached) {
          // Rehash reusable content too: a receipt or a Content-Length header is
          // not an integrity check, and a canceled install can leave full files.
          try {
            if (cached.headers.get('X-Plant-Friends-Sha256') !== file.sha256 || cached.headers.get('Content-Length') !== String(file.bytes)) {
              await cached.body?.cancel();
              throw new Error('Cached file integrity metadata is missing.');
            }
            const reader = verifiedStream(cached, file, signal, bytes => {
              received += bytes;
              progress({ received, total, file: file.url, phase: 'checking' });
            }).getReader();
            try { while (!(await reader.read()).done) { /* bounded verification */ } }
            finally { reader.releaseLock(); }
            continue;
          } catch (error) {
            if (signal.aborted) throw error;
            received = base;
            await cache.delete(key);
            for (const chunk of chunks) await cache.delete(chunk.key);
          }
        }
        if (chunks.length) {
          await downloadChunks(cache, manifestUrl, file, signal, (bytes, phase) => {
            received = base + bytes;
            progress({ received, total, file: file.url, phase });
          });
          continue;
        }
        const url = new URL(file.url, manifestUrl).href;
        const response = await networkResponse(url, manifestUrl, signal);
        let verificationFailure: unknown;
        const failedWrite = new AbortController();
        const stream = verifiedStream(response, file, AbortSignal.any([signal, failedWrite.signal]), bytes => {
          received += bytes;
          progress({ received, total, file: file.url, phase: 'downloading' });
        }, error => { verificationFailure = error; });
        const staged = new Response(stream, { headers: {
          'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
          'Content-Length': String(file.bytes), 'X-Plant-Friends-Sha256': file.sha256,
        } });
        try { await cache.put(key, staged); }
        catch (error) {
          // A failed Cache write must stop an in-flight network reader too.
          failedWrite.abort();
          // Cache.put is atomic, but discard a previously corrupt entry too.
          await cache.delete(key);
          if (!staged.bodyUsed) await staged.body?.cancel().catch(() => undefined);
          if (verificationFailure == null && error instanceof DOMException && error.name === 'UnknownError')
            throw new Error('The browser could not save this offline file. Retry in a regular browser window, allow site storage, or free space.' +
              (manifest.kind === 'bioclip2' ? ' Your installed PFAF catalog remains available.' : ' Any previously installed catalog is kept.'), { cause: error });
          throw verificationFailure ?? error;
        }
      }
      signal.throwIfAborted();
      await verifyPackContents({ manifestUrl, manifest, installedAt: '', persistent: false }, signal);
      signal.throwIfAborted();
      const persistent = await navigator.storage?.persist?.().catch(() => false) ?? false;
      signal.throwIfAborted();
      const receipt: InstalledPack = { manifestUrl, manifest, installedAt: new Date().toISOString(), persistent };
      // All immutable content is verified before this one IDB transaction makes
      // it active. Failed/canceled upgrades cannot replace the previous bytes.
      await receiptStore('readwrite', store => {
        const request = store.put(receipt, manifest.kind);
        request.onsuccess = () => store.delete(`pending:${manifest.kind}`);
        return request;
      });
      // Cleanup cannot roll back an already committed installation. A later
      // delete/install retries it if a browser interruption prevents pruning.
      await pruneUnreferenced().catch(() => undefined);
      return receipt;
    });
  } catch (error) {
    if (signal.aborted) throw new DOMException('Download canceled. You can retry when ready.', 'AbortError');
    if (error instanceof DOMException && error.name === 'QuotaExceededError')
      throw new Error('There is not enough browser storage. Free space or delete an installed pack, then retry.', { cause: error });
    if (error instanceof DOMException && ['SecurityError', 'NotSupportedError'].includes(error.name))
      throw new Error('Offline storage is unavailable. Allow site storage in a supported browser, then retry.', { cause: error });
    if (error instanceof DOMException && error.name === 'UnknownError')
      throw new Error('The browser could not save this offline file. Retry in a regular browser window, allow site storage, or free space. Saved chunks and any installed pack are kept.', { cause: error });
    throw error;
  }
}

export async function deletePack(kind: PackManifest['kind']): Promise<void> {
  await mutateStorage(undefined, async () => {
    await receiptStore('readwrite', store => {
      const request = store.delete(kind);
      request.onsuccess = () => store.delete(`pending:${kind}`);
      return request;
    });
    // Also clear abandoned downloads while retaining the other independent pack.
    await pruneUnreferenced();
  });
}
