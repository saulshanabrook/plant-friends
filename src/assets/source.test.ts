import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { availablePack } from './source';
import { installedPack } from './storage';
vi.mock('./storage', () => ({ installedPack: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('location', { origin: 'https://example.test' });
  vi.mocked(installedPack).mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

for (const part of ['pointer', 'manifest']) {
  test(`metadata deadline aborts a stalled ${part} body, not only response headers`, async () => {
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      if (part === 'manifest' && String(_url).endsWith('model.json')) return Response.json({ url: 'packs/model/manifest.json' });
      return new Response(new ReadableStream({ start(controller) {
        options.signal!.addEventListener('abort', () => { aborted = true; controller.error(options.signal!.reason); }, { once: true });
      } }));
    }));
    const pending = availablePack('bioclip2');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(part === 'pointer' ? 1 : 2);
  });
}

test('explicit cancellation aborts the metadata body without returning a saved fallback', async () => {
  let requestSignal: AbortSignal;
  vi.stubGlobal('fetch', vi.fn(async (_url, options: RequestInit) => {
    requestSignal = options.signal!;
    return new Response(new ReadableStream({ start(controller) {
      requestSignal.addEventListener('abort', () => controller.error(requestSignal.reason), { once: true });
    } }));
  }));
  const cancel = new AbortController();
  const pending = availablePack('pfaf', cancel.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1);
  cancel.abort();
  await rejected;
  expect(requestSignal!.aborted).toBe(true);
  expect(installedPack).not.toHaveBeenCalled();
});

test('a null pointer is invalid metadata, not a transient network failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(null)));
  await expect(availablePack('bioclip2')).rejects.toMatchObject({ name: 'Error', message: 'The offline-pack pointer is invalid.' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
