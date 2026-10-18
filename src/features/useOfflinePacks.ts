import { useEffect, useRef, useState } from 'react';
import type { CatalogEntry, PackManifest } from '../assets/manifest';
import { availablePack, catalogIndex } from '../assets/source';
import { installPack, installedPack, type DownloadProgress, type InstalledPack } from '../assets/storage';

type PackKind = PackManifest['kind'];
interface PackState {
  available: { manifestUrl: string; manifest: PackManifest } | null;
  installed: InstalledPack | null;
  checking: boolean;
  downloading: boolean;
  progress: DownloadProgress | null;
  error: string | null;
}
type Phase = 'checking' | 'downloading' | 'waiting' | 'error' | 'idle';
const initial: PackState = { available: null, installed: null, checking: true, downloading: false, progress: null, error: null };

/** Sequential automatic setup. Transient failures have a finite visible retry budget. */
export function useOfflinePacks() {
  const snapshot = useRef({ pfaf: { ...initial }, bioclip2: { ...initial } });
  const [packs, setPacks] = useState(snapshot.current);
  const index = useRef<CatalogEntry[]>([]);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [phase, setPhase] = useState<Phase>('checking');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(0);

  // Keep async orchestration and rendered state on the same snapshot.
  function update(kind: PackKind, patch: Partial<PackState>) {
    snapshot.current = { ...snapshot.current, [kind]: { ...snapshot.current[kind], ...patch } };
    setPacks(snapshot.current);
  }

  function failed(error: unknown) {
    const transient = !navigator.onLine || error instanceof Error && ['NetworkError', 'TimeoutError'].includes(error.name);
    setSetupError(error instanceof Error ? error.message : 'Offline setup failed. Reopen this page to try again.');
    setPhase(transient ? 'waiting' : 'error');
    if (transient && navigator.onLine && document.visibilityState === 'visible' && retries.current < 3) {
      const delay = 1_000 * 2 ** retries.current++;
      setRetrying(true);
      retryTimer.current = setTimeout(() => { retryTimer.current = null; setRetrying(false); void run(); }, delay);
    }
  }

  async function run() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    const operation = ++generation.current;
    const current = () => operation === generation.current && !controller.signal.aborted;
    setPhase('checking'); setSetupError(null);
    const failures = new Map<PackKind, unknown>();
    try {
      await Promise.all((['pfaf', 'bioclip2'] as const).map(async kind => {
        update(kind, { checking: true, error: null });
        const [saved, prepared] = await Promise.allSettled([installedPack(kind), availablePack(kind, controller.signal)]);
        if (!current()) return;
        let installed = saved.status === 'fulfilled' ? saved.value : null;
        let error = saved.status === 'rejected' ? saved.reason : prepared.status === 'rejected' && !installed ? prepared.reason : null;
        if (kind === 'pfaf') {
          try {
            const value = installed ? await catalogIndex(installed) : [];
            if (!current()) return;
            index.current = value; setEntries(value);
          } catch (failure) {
            if (!current()) return;
            installed = null; index.current = []; setEntries([]); error = failure;
          }
        }
        if (!current()) return;
        update(kind, { installed, available: prepared.status === 'fulfilled' ? prepared.value : null, checking: false, error: error ? error instanceof Error ? error.message : String(error) : null });
        if (error) failures.set(kind, error);
      }));
      for (const kind of ['pfaf', 'bioclip2'] as const) {
        if (!current()) return;
        const pack = snapshot.current[kind];
        if (pack.installed) continue;
        if (!pack.available) { failed(failures.get(kind) ?? new Error('Download metadata is unavailable. Reopen this page to retry.')); return; }
        if (!navigator.onLine) { failed(new DOMException('Waiting for connection.', 'NetworkError')); return; }
        if (kind === 'bioclip2') {
          const catalog = snapshot.current.pfaf.installed?.manifest;
          const model = pack.available.manifest;
          if (catalog?.kind !== 'pfaf' || model.kind !== 'bioclip2' || catalog.id !== model.catalog.id || catalog.sourceSha256 !== model.catalog.sourceSha256 || index.current.length !== model.catalog.fullTaxonCount) {
            failed(new Error('The model needs a matching PFAF catalog. Reopen this page after compatible downloads are available.')); return;
          }
        }
        setPhase('downloading'); update(kind, { downloading: true, progress: null, error: null });
        try {
          const receipt = await installPack(pack.available.manifestUrl, pack.available.manifest, controller.signal, progress => {
            if (current()) update(kind, { progress });
          });
          if (!current()) return;
          if (kind === 'pfaf') {
            const value = await catalogIndex(receipt);
            if (!current()) return;
            index.current = value; setEntries(value);
          }
          update(kind, { installed: receipt, downloading: false });
        } catch (error) {
          if (!current()) return;
          update(kind, { downloading: false, error: error instanceof Error ? error.message : 'Download failed.' });
          failed(error); return;
        }
      }
      if (current()) { retries.current = 0; setPhase('idle'); }
    } catch (error) { if (current()) failed(error); }
    finally { if (active.current === controller) active.current = null; }
  }

  useEffect(() => {
    void run();
    const interrupt = () => {
      generation.current++; active.current?.abort(); active.current = null;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null; setRetrying(false);
      for (const kind of ['pfaf', 'bioclip2'] as const) update(kind, { checking: false, downloading: false });
    };
    const offline = () => { interrupt(); setPhase('waiting'); };
    const recover = () => {
      if (document.visibilityState !== 'visible') {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = null; setRetrying(false);
        return;
      }
      if (!navigator.onLine) return;
      // A suspended fetch can remain pending after the screen locks. Its durable
      // chunks survive aborting this attempt and reopening the range installer.
      interrupt(); retries.current = 0; void run();
    };
    window.addEventListener('offline', offline); window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      generation.current++; active.current?.abort(); active.current = null;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      window.removeEventListener('offline', offline); window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, []);

  return { packs, entries, phase, setupError, retrying };
}
