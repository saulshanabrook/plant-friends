import { useEffect, useRef, useState } from 'react';
import type { InstalledPack } from '../assets/storage';
import { cachePhotoAlbum, loadPhotoAlbum, photoInventory, type PhotoAlbum, type PhotoProgress, type PlantPhoto } from '../assets/photos';

export interface PlantPhotosState {
  photosByPlant: Record<string, PlantPhoto[]>;
  phase: 'checking' | 'waiting' | 'downloading' | 'ready' | 'error';
  progress: PhotoProgress;
  error: string | null;
}
const empty: PlantPhotosState = { photosByPlant: {}, phase: 'waiting', progress: { received: 0, total: 0, completed: 0, totalFiles: 0 }, error: null };

/** Own one catalog's metadata/queue lifecycle, including bounded visible retry.
 * Readiness changes stop only bulk work; metadata remains available for native images. */
export function startPhotoSync(catalog: InstalledPack, initialModelReady: boolean, publish: (state: PlantPhotosState) => void) {
  let state = { ...empty }, album: PhotoAlbum | undefined;
  let modelReady = initialModelReady, disposed = false, interrupted = false;
  let generation = 0, attempts = 0, bulk = false;
  let active: AbortController | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  const update = (patch: Partial<PlantPhotosState>) => { state = { ...state, ...patch }; publish(state); };
  const visible = () => document.visibilityState === 'visible';
  async function run() {
    if (disposed || active || !visible()) return;
    const controller = new AbortController(); active = controller;
    const operation = ++generation;
    const current = () => !disposed && generation === operation && !controller.signal.aborted;
    attempts++; interrupted = false;
    try {
      if (!album) {
        update({ phase: 'checking', error: null });
        const loaded = await loadPhotoAlbum(catalog, controller.signal);
        if (!current()) return;
        album = loaded;
        update({ photosByPlant: loaded.photosByPlant, progress: {
          received: 0, completed: 0, totalFiles: loaded.files.length, total: loaded.files.reduce((sum, photo) => sum + photo.bytes, 0),
        } });
      }
      if (!modelReady) {
        const saved = await photoInventory(album);
        if (!current()) return;
        update({ progress: saved.progress });
        if (!modelReady) { update({ phase: 'waiting', error: null }); return; }
      }
      bulk = true;
      update({ phase: 'downloading', error: null });
      await cachePhotoAlbum(album, controller.signal, progress => { if (current()) update({ progress }); });
      if (current()) update({ phase: 'ready', error: null });
    } catch (error) {
      if (!current()) return;
      interrupted = !navigator.onLine || error instanceof Error && ['NetworkError', 'TimeoutError'].includes(error.name);
      update({ phase: interrupted ? 'waiting' : 'error', error: error instanceof Error ? error.message : 'Reference photos could not be saved. Reload to retry.' });
    } finally {
      if (active === controller) { active = undefined; bulk = false; }
      if (current() && interrupted && attempts < 3 && visible() && navigator.onLine)
        retry = setTimeout(() => { retry = undefined; void run(); }, attempts === 1 ? 1_000 : 4_000);
    }
  }
  function stop() {
    generation++; clearTimeout(retry); retry = undefined;
    active?.abort(); active = undefined; bulk = false;
  }
  function recover() {
    if (disposed || !visible()) return;
    if (active) { stop(); interrupted = true; }
    if (interrupted || state.phase === 'error' || state.phase === 'waiting' && !album) {
      clearTimeout(retry); retry = undefined; attempts = 0; void run();
    }
  }
  function offline() {
    if (state.phase === 'ready') return;
    stop(); interrupted = true; update({ phase: 'waiting' });
    // Cached metadata and completed images remain usable without a connection.
    if (visible()) void run();
  }
  window.addEventListener('online', recover);
  window.addEventListener('offline', offline);
  document.addEventListener('visibilitychange', recover);
  void run();
  return {
    setModelReady(ready: boolean) {
      if (disposed || ready === modelReady) return;
      modelReady = ready;
      if (!ready && bulk) { stop(); update({ phase: 'waiting' }); }
      if (ready && !active && (album || interrupted)) { clearTimeout(retry); retry = undefined; attempts = 0; void run(); }
    },
    dispose() {
      disposed = true; stop();
      window.removeEventListener('online', recover); window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', recover);
    },
  };
}

export function usePlantPhotos(catalog: InstalledPack | null, modelReady: boolean): PlantPhotosState {
  const [state, setState] = useState<PlantPhotosState>(empty);
  const sync = useRef<ReturnType<typeof startPhotoSync> | null>(null);
  const readiness = useRef(modelReady); readiness.current = modelReady;
  useEffect(() => {
    setState(empty);
    if (!catalog) return;
    const current = startPhotoSync(catalog, readiness.current, setState);
    sync.current = current;
    return () => { current.dispose(); if (sync.current === current) sync.current = null; };
  }, [catalog?.manifest.id, catalog?.manifestUrl]);
  useEffect(() => { sync.current?.setModelReady(modelReady); }, [modelReady]);
  return state;
}
