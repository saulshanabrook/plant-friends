import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogEntry, PackManifest } from '../assets/manifest';
import { availablePack, catalogIndex } from '../assets/source';
import { deletePack, installPack, installedPack, type DownloadProgress, type InstalledPack } from '../assets/storage';

type PackKind = PackManifest['kind'];
interface PackState {
  available: { manifestUrl: string; manifest: PackManifest } | null;
  installed: InstalledPack | null;
  checking: boolean;
  downloading: boolean;
  progress: DownloadProgress | null;
  error: string | null;
}
const initialState: PackState = { available: null, installed: null, checking: true, downloading: false, progress: null, error: null };

/** Owns installation lifetimes and keeps catalog browsing tied to verified receipts. */
export function useOfflinePacks() {
  const [packs, setPacks] = useState<Record<PackKind, PackState>>({ pfaf: { ...initialState }, bioclip2: { ...initialState } });
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const downloads = useRef<Partial<Record<PackKind, AbortController>>>({});
  const generation = useRef(0);
  const targetModel = packs.bioclip2.available?.manifest;
  const installedCatalog = packs.pfaf.installed?.manifest;
  const modelCatalogPrerequisite = targetModel?.kind !== 'bioclip2' ? null
    : packs.pfaf.checking || packs.pfaf.downloading
      ? 'Wait for the PFAF catalog check or download to finish before downloading identification.'
      : installedCatalog?.kind !== 'pfaf' || entries.length !== installedCatalog.taxonCount
        ? 'First download the PFAF plant catalog. Identification needs its matching, verified offline records.'
        : installedCatalog.id !== targetModel.catalog.id || installedCatalog.sourceSha256 !== targetModel.catalog.sourceSha256 || entries.length !== targetModel.catalog.fullTaxonCount
          ? 'This identification pack needs a different PFAF catalog. Check available downloads and install the matching catalog update first. Your saved catalog is still available in Explore plants.'
          : null;

  const refresh = useCallback(async () => {
    const check = ++generation.current;
    setPacks(previous => ({
      pfaf: { ...previous.pfaf, checking: true, error: null },
      bioclip2: { ...previous.bioclip2, checking: true, error: null },
    }));
    const checks = await Promise.allSettled((['pfaf', 'bioclip2'] as const).map(async kind => {
      const [receipt, prepared] = await Promise.allSettled([installedPack(kind), availablePack(kind)]);
      if (check !== generation.current) return;
      const installed = receipt.status === 'fulfilled' ? receipt.value : null;
      let error = receipt.status === 'rejected' ? String(receipt.reason instanceof Error ? receipt.reason.message : receipt.reason) : null;
      if (kind === 'pfaf') {
        try {
          const index = installed ? await catalogIndex(installed) : [];
          if (check === generation.current) setEntries(index);
        } catch (failure) {
          if (check === generation.current) setEntries([]);
          error = failure instanceof Error ? failure.message : 'The catalog could not be opened. Reinstall it.';
        }
      }
      if (check !== generation.current) return;
      setPacks(previous => ({ ...previous, [kind]: {
        ...previous[kind], installed, checking: false,
        available: prepared.status === 'fulfilled' ? prepared.value : null,
        error: error ?? (prepared.status === 'rejected' && !installed
          ? prepared.reason instanceof SyntaxError
            ? 'A compatible offline pack is not available from this host yet. Check available downloads and try again.'
            : prepared.reason instanceof Error ? prepared.reason.message : 'No prepared pack is available on this host.'
          : null),
      } }));
    }));
    for (const result of checks) {
      if (result.status === 'rejected') console.error('Offline pack check failed', result.reason);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
      for (const controller of Object.values(downloads.current)) controller.abort();
    };
  }, [refresh]);

  async function install(kind: PackKind) {
    const prepared = packs[kind].available;
    if (!prepared || downloads.current[kind]) return;
    if (kind === 'bioclip2' && modelCatalogPrerequisite) {
      setPacks(previous => ({ ...previous, bioclip2: { ...previous.bioclip2, error: modelCatalogPrerequisite } }));
      return;
    }
    const controller = new AbortController();
    downloads.current[kind] = controller;
    setPacks(previous => ({ ...previous, [kind]: { ...previous[kind], downloading: true, error: null, progress: null } }));
    try {
      const receipt = await installPack(prepared.manifestUrl, prepared.manifest, controller.signal, progress => {
        setPacks(previous => ({ ...previous, [kind]: { ...previous[kind], progress } }));
      });
      if (kind === 'pfaf') setEntries(await catalogIndex(receipt));
      setPacks(previous => ({ ...previous, [kind]: { ...previous[kind], installed: receipt } }));
    } catch (error) {
      setPacks(previous => ({ ...previous, [kind]: { ...previous[kind], error: controller.signal.aborted
        ? 'Download canceled. Retry when you are ready.'
        : error instanceof Error ? error.message : 'The download failed. Check your connection and retry.' } }));
    } finally {
      delete downloads.current[kind];
      setPacks(previous => ({ ...previous, [kind]: { ...previous[kind], downloading: false, progress: null } }));
    }
  }

  async function remove(kind: PackKind) {
    if (downloads.current[kind]) return;
    try {
      await deletePack(kind);
      if (kind === 'pfaf') setEntries([]);
      setPacks(previous => ({ ...previous, [kind]: { ...previous[kind], installed: null, error: null } }));
    } catch (error) {
      setPacks(previous => ({ ...previous, [kind]: { ...previous[kind], error: error instanceof Error ? error.message : 'The offline pack could not be removed. Try again.' } }));
    }
  }

  return { packs, entries, refresh, install, remove, downloads, modelCatalogPrerequisite };
}
