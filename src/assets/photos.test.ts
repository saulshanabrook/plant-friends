import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cachePhotoAlbum, cachePlantPhoto, handlesPhotoRequest, loadPhotoAlbum, photoResponse, PHOTO_CACHE, validatePhotoManifest } from './photos';
import { catalogIndex } from './source';
import type { InstalledPack } from './storage';
import { catalog } from '../../tests/assets/fixtures';
vi.mock('./source', () => ({ catalogIndex: vi.fn() }));

const ORIGIN = 'https://plants.test';
const manifestUrl = `${ORIGIN}/photos/0123456789abcdefabcd/manifest.json`;
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
class MemoryCache {
  entries = new Map<string, { bytes: Uint8Array; headers: Headers }>();
  match = vi.fn(async (input: RequestInfo | URL) => {
    const entry = this.entries.get(input instanceof Request ? input.url : String(input));
    return entry && new Response(entry.bytes.slice(), { headers: entry.headers });
  });
  put = vi.fn(async (input: RequestInfo | URL, response: Response) => {
    if (response.status !== 200) throw new Error('Cache API rejects partial responses');
    this.entries.set(input instanceof Request ? input.url : String(input), { bytes: new Uint8Array(await response.arrayBuffer()), headers: new Headers(response.headers) });
  });
  delete = vi.fn(async (input: RequestInfo | URL) => this.entries.delete(input instanceof Request ? input.url : String(input)));
  keys = vi.fn(async () => [...this.entries.keys()].map(url => new Request(url)));
}
function fixture(count = 2) {
  const bodies = new Map<string, Uint8Array>();
  const images: Record<string, { url: string; bytes: number; sha256: string; width: number; height: number; originalUrl: string; originalSha256: string }> = {};
  const associations = [];
  for (let index = 0; index < count; index++) {
    // Fabricated RIFF/WebP framing exercises integrity/bounds, not image decoding.
    const bytes = new Uint8Array([82, 73, 70, 70, 8, 0, 0, 0, 87, 69, 66, 80, index, 0, 0, 0]);
    const originalUrl = `https://source.test/photo-${index}.jpg`;
    const id = sha(originalUrl), digest = sha(bytes);
    images[id] = { url: `files/${digest}.webp`, bytes: bytes.length, sha256: digest, width: 640, height: 320, originalUrl, originalSha256: 'f'.repeat(64) };
    associations.push({ photoId: id, credit: index ? null : '<b>Literal credit</b>' });
    bodies.set(new URL(images[id].url, manifestUrl).href, bytes);
  }
  return { raw: { schemaVersion: 1, id: '0123456789abcdefabcd', catalogId: 'fixture-catalog',
    source: { repository: 'https://github.com/example/photos', commit: 'a'.repeat(40), databaseSha256: 'b'.repeat(64) },
    images, plants: { 'taxon-0': associations, 'taxon-1': [] } }, bodies };
}
let cache: MemoryCache;
let fetcher: ReturnType<typeof vi.fn>;
const catalogPack = (): InstalledPack => ({ manifestUrl: `${ORIGIN}/packs/pfaf/test/manifest.json`, manifest: catalog(), installedAt: '', persistent: false });
beforeEach(() => {
  cache = new MemoryCache();
  vi.stubGlobal('location', { origin: ORIGIN });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('caches', { open: vi.fn(async (name: string) => { expect(name).toBe(PHOTO_CACHE); return cache; }) });
  fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  vi.mocked(catalogIndex).mockResolvedValue(['taxon-0', 'taxon-1'].map(id => ({ id, scientificName: id, commonName: '', detailFile: 'details.json' })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('validates catalog membership and associations, preserves literal credit, and deduplicates physical images', () => {
  const { raw } = fixture();
  const ids = Object.keys(raw.images);
  raw.images[ids[1]] = { ...raw.images[ids[0]], originalUrl: raw.images[ids[1]].originalUrl };
  const album = validatePhotoManifest(raw, manifestUrl, 'fixture-catalog', new Set(['taxon-0', 'taxon-1']));
  expect(album.files).toHaveLength(1);
  expect(album.photosByPlant['taxon-0']).toHaveLength(2);
  expect(album.photosByPlant['taxon-0'][0].credit).toBe('<b>Literal credit</b>');
  expect(album.photosByPlant['taxon-0'][1].credit).toBeNull();
  expect(album.photosByPlant['taxon-0'][0].url).toMatch(/^https:\/\/plants.test\/photos\//);
});

test.each(['binding', 'foreign plant', 'missing plant', 'unknown image', 'orphan image', 'unsafe image', 'unsafe source', 'wrong source ID', 'dimensions', 'oversized', 'credit'])('rejects %s metadata before it can become a usable album', variant => {
  const { raw } = fixture();
  const image = Object.values(raw.images)[0];
  if (variant === 'binding') raw.catalogId = 'foreign';
  if (variant === 'foreign plant') Object.assign(raw.plants, { foreign: [] });
  if (variant === 'missing plant') delete (raw.plants as Record<string, unknown>)['taxon-1'];
  if (variant === 'unknown image') raw.plants['taxon-0'][0].photoId = 'e'.repeat(64);
  if (variant === 'orphan image') raw.plants['taxon-0'].pop();
  if (variant === 'unsafe image') image.url = `https://evil.test/${image.sha256}.webp`;
  if (variant === 'unsafe source') image.originalUrl = 'javascript:alert(1)';
  if (variant === 'wrong source ID') image.originalUrl = 'https://source.test/different.jpg';
  if (variant === 'dimensions') image.width = 641;
  if (variant === 'oversized') image.bytes = 4 * 1024 * 1024 + 1;
  if (variant === 'credit') (raw.plants['taxon-0'][0] as unknown as { credit: unknown }).credit = {};
  expect(() => validatePhotoManifest(raw, manifestUrl, 'fixture-catalog', new Set(['taxon-0', 'taxon-1']))).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

test('verifies pointer/manifest bytes, retains offline metadata and serves it through the photo route', async () => {
  const { raw } = fixture();
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const pointer = { url: 'photos/0123456789abcdefabcd/manifest.json', bytes: bytes.length, sha256: sha(bytes) };
  fetcher.mockResolvedValueOnce(Response.json(pointer)).mockResolvedValueOnce(new Response(bytes));
  const album = await loadPhotoAlbum(catalogPack(), new AbortController().signal);
  expect(album.files).toHaveLength(2);
  expect(cache.entries.size).toBe(2);
  expect(fetcher.mock.calls.every(([, options]) => options.cache === 'no-store')).toBe(true);
  expect(fetcher.mock.calls.every(([, options]) => options.mode === 'same-origin' && options.redirect === 'manual')).toBe(true);
  vi.stubGlobal('navigator', { onLine: false });
  fetcher.mockClear();
  const offline = await loadPhotoAlbum(catalogPack(), new AbortController().signal);
  expect(offline).toEqual(album);
  expect(await (await photoResponse(new Request(`${ORIGIN}/photos.json`))).json()).toEqual(pointer);
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(['hash', 'bytes', 'unsafe pointer', 'null pointer'])('rejects bad %s before caching metadata', async variant => {
  const { raw } = fixture();
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const pointer = { url: variant === 'unsafe pointer' ? 'https://evil.test/manifest.json' : 'photos/0123456789abcdefabcd/manifest.json',
    bytes: bytes.length + (variant === 'bytes' ? 1 : 0), sha256: variant === 'hash' ? 'e'.repeat(64) : sha(bytes) };
  fetcher.mockResolvedValueOnce(Response.json(variant === 'null pointer' ? null : pointer)).mockResolvedValueOnce(new Response(bytes));
  const error = await loadPhotoAlbum(catalogPack(), new AbortController().signal).catch(error => error);
  expect(error.name).toBe('Error');
  expect(cache.entries.size).toBe(0);
});

test('compressed metadata validates decoded bytes rather than compressed Content-Length', async () => {
  const { raw } = fixture();
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  fetcher.mockResolvedValueOnce(Response.json({ url: 'photos/0123456789abcdefabcd/manifest.json', bytes: bytes.length, sha256: sha(bytes) }))
    .mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '12' } }));
  expect((await loadPhotoAlbum(catalogPack(), new AbortController().signal)).files).toHaveLength(2);
});

test('native images are validated atomically and reused across album versions without an external request', async () => {
  const { raw, bodies } = fixture(1);
  const photo = validatePhotoManifest(raw, manifestUrl, 'fixture-catalog', new Set(['taxon-0', 'taxon-1'])).files[0];
  fetcher.mockResolvedValue(new Response(bodies.get(photo.url)!.slice()));
  const response = await cachePlantPhoto(photo.url);
  expect(response.headers.get('Content-Type')).toBe('image/webp');
  expect(cache.put).toHaveBeenCalledTimes(1);
  vi.stubGlobal('navigator', { onLine: false });
  const later = photo.url.replace('0123456789abcdefabcd', 'fedcba9876543210abcd');
  expect((await (await photoResponse(new Request(later))).arrayBuffer()).byteLength).toBe(photo.bytes);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(handlesPhotoRequest(later)).toBe(true);
  expect(handlesPhotoRequest('https://evil.test/photos/photo.webp')).toBe(false);
  expect(handlesPhotoRequest(`${ORIGIN}/different-app/photos/photo.webp`)).toBe(false);
});

test.each(['hash', 'oversized', '206', 'unsafe'])('never caches a %s image response', async variant => {
  const { raw, bodies } = fixture(1);
  const photo = validatePhotoManifest(raw, manifestUrl, 'fixture-catalog', new Set(['taxon-0', 'taxon-1'])).files[0];
  let bytes = bodies.get(photo.url)!.slice();
  if (variant === 'hash') bytes[12] ^= 1;
  if (variant === 'oversized') bytes = new Uint8Array(photo.bytes + 1);
  fetcher.mockResolvedValueOnce(new Response(bytes, { status: variant === '206' ? 206 : 200 }));
  await expect(cachePlantPhoto(variant === 'unsafe' ? 'https://evil.test/image.webp' : photo)).rejects.toThrow();
  expect(cache.put).not.toHaveBeenCalled();
  if (variant === 'unsafe') expect(fetcher).not.toHaveBeenCalled();
});

test('one inventory restores progress and skips all completed image bodies on a new queue', async () => {
  const { raw, bodies } = fixture(8);
  const album = validatePhotoManifest(raw, manifestUrl, 'fixture-catalog', new Set(['taxon-0', 'taxon-1']));
  fetcher.mockImplementation(async (url: string) => new Response(bodies.get(url)!.slice()));
  const abort = new AbortController();
  await expect(cachePhotoAlbum(album, abort.signal, value => { if (value.completed >= 2) abort.abort(); })).rejects.toMatchObject({ name: 'AbortError' });
  const saved = cache.entries.size;
  expect(saved).toBeGreaterThanOrEqual(2);
  expect(saved).toBeLessThan(8);
  cache.keys.mockClear(); fetcher.mockClear();
  const progress = vi.fn();
  await cachePhotoAlbum(album, new AbortController().signal, progress);
  expect(cache.keys).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(8 - saved);
  expect(progress.mock.calls[0][0].completed).toBe(saved);
  expect(progress.mock.lastCall![0]).toEqual({ received: 128, total: 128, completed: 8, totalFiles: 8 });
  cache.match.mockImplementation(async () => { throw new Error('Startup must not read completed bodies'); });
  cache.keys.mockClear(); fetcher.mockClear();
  await cachePhotoAlbum(album, new AbortController().signal, () => undefined);
  expect(cache.keys).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
});

test('the queue limits concurrency to six and transport failures retain completed images', async () => {
  const { raw, bodies } = fixture(9);
  const album = validatePhotoManifest(raw, manifestUrl, 'fixture-catalog', new Set(['taxon-0', 'taxon-1']));
  let active = 0, maximum = 0;
  fetcher.mockImplementation(async (url: string) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return new Response(bodies.get(url)!.slice());
  });
  await cachePhotoAlbum(album, new AbortController().signal, () => undefined);
  expect(maximum).toBe(6);
  const saved = cache.entries.size;
  cache.entries.delete([...cache.entries.keys()][0]);
  fetcher.mockRejectedValue(new TypeError('network dropped'));
  await expect(cachePhotoAlbum(album, new AbortController().signal, () => undefined)).rejects.toMatchObject({ name: 'NetworkError' });
  expect(cache.entries.size).toBe(saved - 1);
});

test('a stalled image body aborts at its bounded transport deadline', async () => {
  const { raw } = fixture(1);
  const photo = validatePhotoManifest(raw, manifestUrl, 'fixture-catalog', new Set(['taxon-0', 'taxon-1'])).files[0];
  let canceled = false;
  fetcher.mockImplementation(async (_url, options: RequestInit) => {
    options.signal!.addEventListener('abort', () => { canceled = true; });
    return new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }, { highWaterMark: 0 }));
  });
  vi.useFakeTimers();
  const result = cachePlantPhoto(photo).catch(error => error);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await result).toMatchObject({ name: 'TimeoutError' });
  expect(canceled).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(cache.put).not.toHaveBeenCalled();
});
