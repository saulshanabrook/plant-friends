import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { installPack, installedPack, readAsset, deletePack, ASSET_CACHE } from './storage';
import { asset, catalog, model, CONTENT, MANIFEST_URL, MODEL_URL } from '../../tests/assets/fixtures';

// Explicit Cache API double: unit tests exercise stream/activation control flow.
// tests/e2e/install.spec.ts separately uses the actual browser Cache API and IDB.
class MemoryCache {
  entries = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  failPut: Error | undefined;
  onChunk?: () => void;
  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const value = this.entries.get(input instanceof Request ? input.url : String(input));
    return value && new Response(value.bytes.slice(), { headers: value.headers });
  }
  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    if (this.failPut) throw this.failPut;
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value); length += value.byteLength;
        this.onChunk?.();
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    this.entries.set(input instanceof Request ? input.url : String(input), { bytes, headers: new Headers(response.headers) });
  }
  async delete(input: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(input instanceof Request ? input.url : String(input));
  }
  async keys(): Promise<Request[]> { return [...this.entries.keys()].map(url => new Request(url)); }
}

let cache: MemoryCache;
let download: ReturnType<typeof vi.fn>;
beforeEach(() => {
  CONTENT.clear();
  cache = new MemoryCache();
  download = vi.fn(async (url: string) => {
    const content = CONTENT.get(new URL(url).pathname.split('/').pop()!) ??
      [...CONTENT.entries()].find(([relative]) => new URL(relative, MODEL_URL).href === url)?.[1];
    if (!content) return new Response('not found', { status: 404 });
    return new Response(content.slice(), { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
  vi.stubGlobal('fetch', download);
  vi.stubGlobal('navigator', { storage: { persist: vi.fn(async () => false) } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('verified installation with fabricated bytes', () => {
  test('only activates a complete pack, reports actual bytes, and reuses verified cached files', async () => {
    const pack = catalog();
    const progress = vi.fn();
    const receipt = await installPack(MANIFEST_URL, pack, new AbortController().signal, progress);
    expect(receipt.persistent).toBe(false);
    expect((await installedPack('pfaf'))?.manifest.id).toBe(pack.id);
    expect((await (await readAsset(receipt, pack.files[1])).json())['taxon-0'].fields.note).toBe('fixture detail');
    expect(progress.mock.lastCall?.[0]).toEqual({ received: pack.files.reduce((sum, file) => sum + file.bytes, 0), total: pack.files.reduce((sum, file) => sum + file.bytes, 0), file: 'details.json' });
    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    await installPack(MANIFEST_URL, pack, new AbortController().signal, () => undefined);
    expect(download).toHaveBeenCalledTimes(2);
    await expect(readAsset(receipt, { ...pack.files[0], sha256: 'a'.repeat(64) })).rejects.toThrow('does not belong');
  });

  test('rejects malformed packs before fetching or writing cache content', async () => {
    const pack = catalog(); (pack.files as unknown[])[0] = null;
    await expect(installPack(MANIFEST_URL, pack, new AbortController().signal, () => undefined)).rejects.toThrow('metadata');
    expect(download).not.toHaveBeenCalled();
    expect(cache.entries.size).toBe(0);
  });

  test('same-URL failed/canceled replacements preserve the earlier working receipt and bytes', async () => {
    const previous = catalog('old', 'old working details');
    const installed = await installPack(MANIFEST_URL, previous, new AbortController().signal, () => undefined);
    const replacement = catalog('new', 'new details');
    download.mockImplementationOnce(async () => new Response('corrupted replacement'));
    await expect(installPack(MANIFEST_URL, replacement, new AbortController().signal, () => undefined)).rejects.toThrow(/Integrity|size changed/);
    expect((await installedPack('pfaf'))?.manifest.id).toBe('old');
    expect((await (await readAsset(installed, previous.files[1])).json())['taxon-0'].fields.note).toBe('old working details');
    const abort = new AbortController();
    await expect(installPack(MANIFEST_URL, replacement, abort.signal, value => {
      if (value.file === 'details.json') abort.abort();
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect((await installedPack('pfaf'))?.manifest.id).toBe('old');
    expect((await (await readAsset(installed, previous.files[1])).json())['taxon-0'].fields.note).toBe('old working details');
    await installPack(MANIFEST_URL, replacement, new AbortController().signal, () => undefined);
    expect((await installedPack('pfaf'))?.manifest.id).toBe('new');
    expect(cache.entries.has(new URL(`/__plant-friends-verified__/${previous.files[1].sha256}/${previous.files[1].bytes}`, MANIFEST_URL).href)).toBe(false);
  });

  test('cancel removes the interrupted file but keeps completed files for an explicit retry', async () => {
    const pack = catalog();
    const abort = new AbortController();
    await expect(installPack(MANIFEST_URL, pack, abort.signal, value => {
      if (value.file === 'details.json') abort.abort();
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await installedPack('pfaf')).toBeNull();
    expect(cache.entries.size).toBe(1);
    expect(download).toHaveBeenCalledTimes(2);
    await installPack(MANIFEST_URL, pack, new AbortController().signal, () => undefined);
    expect(download).toHaveBeenCalledTimes(3);
    expect(await installedPack('pfaf')).not.toBeNull();
  });

  test('in-flight caller mutations cannot change the reviewed manifest being installed', async () => {
    const pack = catalog('reviewed');
    const receipt = await installPack(MANIFEST_URL, pack, new AbortController().signal, () => {
      pack.id = 'changed during download';
      pack.files.length = 0;
    });
    expect(receipt.manifest.id).toBe('reviewed');
    expect(receipt.manifest.files).toHaveLength(2);
    expect((await installedPack('pfaf'))?.manifest.id).toBe('reviewed');
  });

  test('an overlapping eviction check never deletes a more recently activated receipt', async () => {
    const previous = catalog('old', 'old details');
    await installPack(MANIFEST_URL, previous, new AbortController().signal, () => undefined);
    const oldKey = new URL(`/__plant-friends-verified__/${previous.files[1].sha256}/${previous.files[1].bytes}`, MANIFEST_URL).href;
    const originalMatch = cache.match.bind(cache);
    let reached: () => void;
    const checkingOld = new Promise<void>(resolve => { reached = resolve; });
    let release: () => void;
    const activationFinished = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(cache, 'match').mockImplementation(async input => {
      if (String(input) === oldKey) {
        reached();
        await activationFinished;
        return undefined;
      }
      return originalMatch(input);
    });
    const status = installedPack('pfaf');
    await checkingOld;
    await installPack(MANIFEST_URL, catalog('new', 'new details'), new AbortController().signal, () => undefined);
    release!();
    expect(await status).toBeNull();
    expect((await installedPack('pfaf'))?.manifest.id).toBe('new');
  });

  test.each(['same length wrong hash', 'short', 'oversized'])('rejects %s without installing or keeping an invalid file', async variant => {
    const pack = catalog();
    const correct = CONTENT.get('index.json')!;
    const corrupt = variant === 'short' ? correct.subarray(1) : variant === 'oversized' ? new Uint8Array(correct.length + 1) : new Uint8Array(correct.length);
    download.mockImplementationOnce(async () => new Response(corrupt.slice().buffer));
    await expect(installPack(MANIFEST_URL, pack, new AbortController().signal, () => undefined)).rejects.toThrow(/Integrity|size changed/);
    expect(await installedPack('pfaf')).toBeNull();
    expect(cache.entries.size).toBe(0);
  });

  test('rehashes cached content before reuse and replaces corruption from the network', async () => {
    const pack = catalog();
    await installPack(MANIFEST_URL, pack, new AbortController().signal, () => undefined);
    const first = cache.entries.values().next().value!;
    first.bytes[0] ^= 1;
    await installPack(MANIFEST_URL, pack, new AbortController().signal, () => undefined);
    expect(download).toHaveBeenCalledTimes(3);
    expect((await installedPack('pfaf'))?.manifest.id).toBe(pack.id);
  });

  test('eviction clears readiness and delete removes active and abandoned content', async () => {
    const pack = catalog();
    const receipt = await installPack(MANIFEST_URL, pack, new AbortController().signal, () => undefined);
    cache.entries.delete(cache.entries.keys().next().value!);
    expect(await installedPack('pfaf')).toBeNull();
    await expect(readAsset(receipt, pack.files[0])).rejects.toThrow('evicted');
    await deletePack('pfaf');
    expect(cache.entries.size).toBe(0);
    expect(await installedPack('pfaf')).toBeNull();
  });

  test('catalog and model install/delete independently, preserving shared content', async () => {
    const catalogPack = catalog();
    const modelPack = model();
    modelPack.files.push(catalogPack.files[1]);
    await installPack(MANIFEST_URL, catalogPack, new AbortController().signal, () => undefined);
    const modelReceipt = await installPack(MODEL_URL, modelPack, new AbortController().signal, () => undefined);
    await deletePack('pfaf');
    expect(await installedPack('pfaf')).toBeNull();
    expect(await installedPack('bioclip2')).not.toBeNull();
    expect((await (await readAsset(modelReceipt, catalogPack.files[1])).json())['taxon-0'].fields.note).toBe('fixture detail');
    await deletePack('bioclip2');
    expect(cache.entries.size).toBe(0);
  });

  test('storage exhaustion and failed receipt writes preserve previous activation and offer recovery', async () => {
    const previous = catalog('old', 'old details');
    await installPack(MANIFEST_URL, previous, new AbortController().signal, () => undefined);
    const replacement = catalog('new', 'replacement details');
    cache.failPut = new DOMException('full', 'QuotaExceededError');
    await expect(installPack(MANIFEST_URL, replacement, new AbortController().signal, () => undefined)).rejects.toThrow('not enough browser storage');
    expect((await installedPack('pfaf'))?.manifest.id).toBe('old');
    cache.failPut = undefined;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await expect(installPack(MANIFEST_URL, replacement, new AbortController().signal, () => undefined)).rejects.toThrow('not enough browser storage');
    expect((await installedPack('pfaf'))?.manifest.id).toBe('old');
  });

  test('Cache.put UnknownError offers browser/storage recovery while the installed catalog stays usable', async () => {
    const catalogPack = catalog();
    const catalogReceipt = await installPack(MANIFEST_URL, catalogPack, new AbortController().signal, () => undefined);
    cache.failPut = new DOMException('Unexpected internal error', 'UnknownError');
    await expect(installPack(MODEL_URL, model(), new AbortController().signal, () => undefined))
      .rejects.toThrow('Retry in a regular browser window');
    expect(await installedPack('bioclip2')).toBeNull();
    expect((await installedPack('pfaf'))?.manifest.id).toBe(catalogPack.id);
    expect((await (await readAsset(catalogReceipt, catalogPack.files[1])).json())['taxon-0'].fields.note).toBe('fixture detail');
  });

  test('the verified-stream integrity error takes precedence over a Cache.put UnknownError', async () => {
    const pack = catalog();
    download.mockResolvedValueOnce(new Response(new Uint8Array(pack.files[0].bytes)));
    const put = cache.put.bind(cache);
    vi.spyOn(cache, 'put').mockImplementation(async (request, response) => {
      try { await put(request, response); }
      catch { throw new DOMException('Unexpected internal error', 'UnknownError'); }
    });
    await expect(installPack(MANIFEST_URL, pack, new AbortController().signal, () => undefined)).rejects.toThrow('Integrity check failed');
    expect(await installedPack('pfaf')).toBeNull();
  });

  test('cancellation during persistence permission never activates the completed download', async () => {
    const abort = new AbortController();
    navigator.storage.persist = vi.fn(async () => { abort.abort(); return false; });
    await expect(installPack(MANIFEST_URL, catalog(), abort.signal, () => undefined)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await installedPack('pfaf')).toBeNull();
  });

  test('pre-abort and network errors have useful recovery behavior', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(installPack(MANIFEST_URL, catalog(), abort.signal, () => undefined)).rejects.toMatchObject({ name: 'AbortError' });
    expect(download).not.toHaveBeenCalled();
    download.mockRejectedValueOnce(new TypeError('network unavailable'));
    await expect(installPack(MANIFEST_URL, catalog(), new AbortController().signal, () => undefined)).rejects.toThrow('Check the connection and retry');
  });

  test('correctly hashed malformed catalog JSON or record membership never replaces a working catalog', async () => {
    const previous = catalog('working');
    await installPack(MANIFEST_URL, previous, new AbortController().signal, () => undefined);
    for (const text of ['not JSON', '{}', JSON.stringify({ unknown: { id: 'unknown' } })]) {
      const replacement = catalog('malformed');
      replacement.files[1] = asset('details.json', text);
      await expect(installPack(MANIFEST_URL, replacement, new AbortController().signal, () => undefined)).rejects.toThrow(/details|detail/);
      expect((await installedPack('pfaf'))?.manifest.id).toBe('working');
    }
    const badIndex = catalog('bad-index');
    badIndex.files[0] = asset('index.json', '[null,null,null,null,null]');
    await expect(installPack(MANIFEST_URL, badIndex, new AbortController().signal, () => undefined)).rejects.toThrow('index');
    expect((await installedPack('pfaf'))?.manifest.id).toBe('working');
  });

  test('model setup requires the matching installed catalog before any model download', async () => {
    const pack = model();
    await expect(installPack(MODEL_URL, pack, new AbortController().signal, () => undefined)).rejects.toThrow('Install the matching PFAF catalog');
    expect(download).not.toHaveBeenCalled();
    await installPack(MANIFEST_URL, catalog('other'), new AbortController().signal, () => undefined);
    await expect(installPack(MODEL_URL, pack, new AbortController().signal, () => undefined)).rejects.toThrow('Install the matching PFAF catalog');
    expect(download).toHaveBeenCalledTimes(2);
    expect(await installedPack('bioclip2')).toBeNull();
  });

  test('correctly hashed nonfinite vectors and foreign row mappings never activate over a working model', async () => {
    await installPack(MANIFEST_URL, catalog(), new AbortController().signal, () => undefined);
    const previous = model();
    await installPack(MODEL_URL, previous, new AbortController().signal, () => undefined);
    const invalid = model(); invalid.id = 'invalid-vectors';
    const bytes = CONTENT.get('vectors.f32')!.slice();
    new Float32Array(bytes.buffer)[0] = NaN;
    invalid.vectors.file = asset('vectors.f32', bytes);
    invalid.files = invalid.files.map(file => file.url === 'vectors.f32' ? invalid.vectors.file : file);
    await expect(installPack(MODEL_URL, invalid, new AbortController().signal, () => undefined)).rejects.toThrow('invalid values');
    expect((await installedPack('bioclip2'))?.manifest.id).toBe(previous.id);
    const foreign = model(); foreign.id = 'foreign-rows';
    foreign.catalog.rows = asset('rows.json', JSON.stringify(['foreign', 'taxon-1', 'taxon-2', 'taxon-3', 'taxon-4']));
    foreign.files = foreign.files.map(file => file.url === 'rows.json' ? foreign.catalog.rows : file);
    await expect(installPack(MODEL_URL, foreign, new AbortController().signal, () => undefined)).rejects.toThrow('no PFAF record');
    expect((await installedPack('bioclip2'))?.manifest.id).toBe(previous.id);
  });

  test('large streamed input follows backpressure without buffering/cloning the response in app code', async () => {
    const pack = catalog();
    const size = 16 * 1024;
    const details = JSON.parse(new TextDecoder().decode(CONTENT.get('details.json')));
    details['taxon-0'].fields.note = 'x'.repeat(size * 128);
    const large = new TextEncoder().encode(JSON.stringify(details));
    const count = Math.ceil(large.length / size);
    pack.files[1] = asset('details.json', large);
    let produced = 0, consumed = 0, maximumAhead = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === count) return controller.close();
        const offset = produced * size;
        produced++;
        maximumAhead = Math.max(maximumAhead, produced - consumed);
        controller.enqueue(large.slice(offset, offset + size));
      },
    }, { highWaterMark: 0 });
    const response = new Response(source);
    vi.spyOn(response, 'arrayBuffer').mockImplementation(() => { throw new Error('must stream'); });
    vi.spyOn(response, 'clone').mockImplementation(() => { throw new Error('must not tee'); });
    download.mockResolvedValueOnce(new Response(CONTENT.get('index.json')!.slice())).mockImplementationOnce(async () => {
      cache.onChunk = () => { consumed++; };
      return response;
    });
    await installPack(MANIFEST_URL, pack, new AbortController().signal, () => undefined);
    expect(produced).toBe(count);
    expect(maximumAhead).toBe(1);
    expect(response.arrayBuffer).not.toHaveBeenCalled();
    expect(response.clone).not.toHaveBeenCalled();
    expect(ASSET_CACHE).toBe('plant-friends-packs-v2');
  });
});
