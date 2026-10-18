import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cachePhotoAlbum, loadPhotoAlbum, photoInventory, type PhotoAlbum } from '../assets/photos';
import { startPhotoSync, type PlantPhotosState } from './usePlantPhotos';
import type { InstalledPack } from '../assets/storage';
import { catalog } from '../../tests/assets/fixtures';
vi.mock('../assets/photos', () => ({ loadPhotoAlbum: vi.fn(), cachePhotoAlbum: vi.fn(), photoInventory: vi.fn() }));
const album: PhotoAlbum = { photosByPlant: { plant: [{ url: 'https://plants.test/photos/id/files/image.webp', bytes: 16,
  sha256: 'a'.repeat(64), width: 640, height: 320, sourceUrl: 'https://source.test/photo.jpg', credit: 'Author' }] }, files: [] };
const pack: InstalledPack = { manifestUrl: 'https://plants.test/catalog/manifest.json', manifest: catalog(), installedAt: '', persistent: false };
let win: EventTarget, doc: EventTarget & { visibilityState: string };
let sync: ReturnType<typeof startPhotoSync> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  win = new EventTarget(); doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', win); vi.stubGlobal('document', doc); vi.stubGlobal('navigator', { onLine: true });
  vi.mocked(loadPhotoAlbum).mockResolvedValue(album);
  vi.mocked(cachePhotoAlbum).mockResolvedValue(undefined);
  vi.mocked(photoInventory).mockResolvedValue({ pending: [], progress: { received: 0, total: 0, completed: 0, totalFiles: 0 } });
});
afterEach(() => { sync?.dispose(); sync = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetAllMocks(); });

test('model readiness gates metadata, inventory, publication and bulk across lifecycle events', async () => {
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, false, state => states.push(state));
  await vi.advanceTimersByTimeAsync(0);
  win.dispatchEvent(new Event('online')); doc.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(states.every(state => Object.keys(state.photosByPlant).length === 0)).toBe(true);
  expect(loadPhotoAlbum).not.toHaveBeenCalled();
  expect(photoInventory).not.toHaveBeenCalled();
  expect(cachePhotoAlbum).not.toHaveBeenCalled();
  sync.setModelReady(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(cachePhotoAlbum).toHaveBeenCalledTimes(1);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(1);
  expect(states.at(-1)?.phase).toBe('ready');
});

test('transport recovery is bounded to three visible attempts and resumes on a later visible/online event', async () => {
  vi.mocked(loadPhotoAlbum).mockRejectedValue(new DOMException('connection lost', 'NetworkError'));
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, true, state => states.push(state));
  await vi.advanceTimersByTimeAsync(0);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(3);
  doc.visibilityState = 'hidden'; win.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(3);
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(4);
  expect(states.at(-1)?.phase).toBe('waiting');
  sync.dispose();
  const count = states.length;
  win.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(states).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});

test('permanent failures wait for a later lifecycle event and never create timer retry loops', async () => {
  vi.mocked(cachePhotoAlbum).mockRejectedValue(new Error('integrity failed'));
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, true, state => states.push(state));
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toMatchObject({ phase: 'error', error: 'integrity failed' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(cachePhotoAlbum).toHaveBeenCalledTimes(1);
  win.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(cachePhotoAlbum).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(cachePhotoAlbum).toHaveBeenCalledTimes(2);
  doc.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(cachePhotoAlbum).toHaveBeenCalledTimes(3);
});

test('returning visible aborts suspended work and reopens a single queue without reloading its index', async () => {
  let oldSignal: AbortSignal, rejectOld: (error: Error) => void;
  vi.mocked(cachePhotoAlbum).mockImplementationOnce((_album, signal) => {
    oldSignal = signal;
    return new Promise((_resolve, reject) => { rejectOld = reject; });
  });
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, true, state => states.push(state));
  await vi.advanceTimersByTimeAsync(0);
  doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
  expect(oldSignal!.aborted).toBe(false);
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(oldSignal!.aborted).toBe(true);
  expect(cachePhotoAlbum).toHaveBeenCalledTimes(2);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(1);
  expect(states.at(-1)?.phase).toBe('ready');
  const count = states.length;
  rejectOld!(new DOMException('suspended queue stopped', 'AbortError'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(states).toHaveLength(count);
});

test('offline startup can restore the saved index and a completely cached album', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, true, state => states.push(state));
  await vi.advanceTimersByTimeAsync(0);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(1);
  expect(cachePhotoAlbum).toHaveBeenCalledTimes(1);
  expect(states.at(-1)).toMatchObject({ phase: 'ready', photosByPlant: album.photosByPlant });
  win.dispatchEvent(new Event('offline'));
  expect(states.at(-1)?.phase).toBe('ready');
});

test('an initially hidden offline page restores saved metadata and inventory with an installed model', async () => {
  vi.stubGlobal('navigator', { onLine: false }); doc.visibilityState = 'hidden';
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, true, state => states.push(state));
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toMatchObject({ phase: 'ready', photosByPlant: album.photosByPlant });
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(1);
  expect(cachePhotoAlbum).toHaveBeenCalledTimes(1);
  expect(states.at(-1)).toMatchObject({ phase: 'ready', photosByPlant: album.photosByPlant });
});

test('hidden offline cache restoration still waits for the model gate', async () => {
  vi.stubGlobal('navigator', { onLine: false }); doc.visibilityState = 'hidden';
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, false, state => states.push(state));
  await vi.advanceTimersByTimeAsync(0);
  expect(loadPhotoAlbum).not.toHaveBeenCalled(); expect(cachePhotoAlbum).not.toHaveBeenCalled();
  expect(states.every(state => Object.keys(state.photosByPlant).length === 0)).toBe(true);
  sync.setModelReady(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toMatchObject({ phase: 'ready', photosByPlant: album.photosByPlant });
});

test('network transfer counters include the index but never include an image inventory jump', async () => {
  vi.mocked(loadPhotoAlbum).mockImplementationOnce(async (_catalog, _signal, network) => { network?.(100); return album; });
  vi.mocked(cachePhotoAlbum).mockImplementationOnce(async (_album, _signal, progress, network) => {
    progress({ received: 9_000_000, total: 10_000_000, completed: 900, totalFiles: 1_000 });
    network?.(200);
  });
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, true, state => states.push(state));
  await vi.advanceTimersByTimeAsync(0);
  expect(states.filter(state => state.transfer?.received).map(state => state.transfer!.received)).toContain(100);
  expect(Math.max(...states.map(state => state.transfer?.received ?? 0))).toBe(300);
  expect(states.at(-1)).toMatchObject({ phase: 'ready', metadataReady: true, transfer: null, progress: { received: 9_000_000 } });
});

test('going offline during initial metadata read promptly reopens saved metadata while still visible', async () => {
  let oldSignal: AbortSignal, rejectOld: (error: Error) => void;
  vi.mocked(loadPhotoAlbum).mockImplementationOnce((_catalog, signal) => {
    oldSignal = signal;
    return new Promise((_resolve, reject) => { rejectOld = reject; });
  });
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, true, state => states.push(state));
  vi.stubGlobal('navigator', { onLine: false }); win.dispatchEvent(new Event('offline'));
  await vi.advanceTimersByTimeAsync(0);
  expect(oldSignal!.aborted).toBe(true);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(2);
  expect(states.at(-1)).toMatchObject({ phase: 'ready', photosByPlant: album.photosByPlant });
  const count = states.length;
  rejectOld!(new DOMException('old metadata stopped', 'AbortError'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(states).toHaveLength(count);
});

test('losing model readiness aborts bulk, and late progress/rejection cannot overwrite a later successful attempt', async () => {
  let oldSignal: AbortSignal, oldProgress: Parameters<typeof cachePhotoAlbum>[2], rejectOld: (error: Error) => void;
  vi.mocked(cachePhotoAlbum).mockImplementationOnce((_album, signal, progress) => {
    oldSignal = signal; oldProgress = progress;
    return new Promise((_resolve, reject) => { rejectOld = reject; });
  });
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, true, state => states.push(state));
  await vi.advanceTimersByTimeAsync(0);
  sync.setModelReady(false);
  expect(oldSignal!.aborted).toBe(true);
  expect(states.at(-1)?.phase).toBe('waiting');
  sync.setModelReady(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)?.phase).toBe('ready');
  const count = states.length;
  oldProgress!({ received: 999, total: 999, completed: 99, totalFiles: 99 });
  rejectOld!(new DOMException('old failure', 'NetworkError'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(states).toHaveLength(count);
  expect(loadPhotoAlbum).toHaveBeenCalledTimes(1);
});

test('disposed index loads cannot publish after a new catalog lifecycle starts', async () => {
  let rejectOld: (error: Error) => void;
  vi.mocked(loadPhotoAlbum).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const oldStates: PlantPhotosState[] = [], states: PlantPhotosState[] = [];
  const previous = startPhotoSync(pack, true, state => oldStates.push(state));
  previous.dispose();
  const count = oldStates.length;
  sync = startPhotoSync(pack, true, state => states.push(state));
  await vi.advanceTimersByTimeAsync(0);
  rejectOld!(new Error('old index failed'));
  await vi.advanceTimersByTimeAsync(0);
  expect(oldStates).toHaveLength(count);
  expect(states.at(-1)).toMatchObject({ phase: 'ready', photosByPlant: album.photosByPlant, error: null });
});

test('losing model readiness aborts index work and blocks late publication and network counters', async () => {
  let signal: AbortSignal, resolveOld: (value: PhotoAlbum) => void, network: (bytes: number) => void;
  vi.mocked(loadPhotoAlbum).mockImplementationOnce((_catalog, currentSignal, received) => {
    signal = currentSignal; network = received!;
    return new Promise(resolve => { resolveOld = resolve; });
  });
  const states: PlantPhotosState[] = [];
  sync = startPhotoSync(pack, true, state => states.push(state));
  sync.setModelReady(false);
  expect(signal!.aborted).toBe(true);
  const count = states.length;
  network!(9_800_000); resolveOld!(album);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(states).toHaveLength(count);
  expect(states.at(-1)).toMatchObject({ photosByPlant: {}, transfer: null, phase: 'waiting' });
  expect(cachePhotoAlbum).not.toHaveBeenCalled();
  sync.setModelReady(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)).toMatchObject({ photosByPlant: album.photosByPlant, phase: 'ready' });
});
