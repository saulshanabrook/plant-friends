import type { CatalogEntry, CatalogManifest, PackManifest } from './manifest';
import { validateManifest, validateCatalogIndex } from './manifest';
import { installedPack, readAsset, type InstalledPack } from './storage';

export async function availablePack(kind: PackManifest['kind'], signal?: AbortSignal): Promise<{ manifestUrl: string; manifest: PackManifest }> {
  if (!navigator.onLine) {
    const installed = await installedPack(kind);
    if (installed) return installed;
    throw new DOMException('Connect to download this pack.', 'NetworkError');
  }
  // One deadline covers headers AND JSON bodies for both small metadata requests.
  const request = new AbortController();
  const cancel = () => request.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(() => request.abort(new DOMException('Download metadata timed out. Retry when connected.', 'TimeoutError')), 20_000);
  try {
    const pointerUrl = new URL(`${import.meta.env.BASE_URL}${kind === 'pfaf' ? 'catalog' : 'model'}.json`, location.origin);
    const pointerResponse = await fetch(pointerUrl, { cache: 'no-cache', signal: request.signal });
    if (!pointerResponse.ok) throw new Error(`Download metadata is unavailable (HTTP ${pointerResponse.status}). Retry later.`);
    const pointer = await pointerResponse.json();
    if (!pointer || typeof pointer !== 'object' || typeof pointer.url !== 'string') throw new Error('The offline-pack pointer is invalid.');
    const manifestUrl = new URL(pointer.url, pointerUrl).href;
    if (new URL(manifestUrl).origin !== location.origin) throw new Error('Offline packs must be hosted on this site.');
    const response = await fetch(manifestUrl, { cache: 'no-cache', signal: request.signal });
    if (!response.ok) throw new Error(`The offline pack could not be checked (HTTP ${response.status}). Retry later.`);
    const manifest = validateManifest(await response.json(), manifestUrl);
    if (manifest.kind !== kind) throw new Error('The host points to the wrong offline pack.');
    return { manifestUrl, manifest };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const installed = await installedPack(kind);
    if (installed) return installed;
    if (request.signal.aborted) throw request.signal.reason;
    if (error instanceof SyntaxError) throw new Error('Download metadata is invalid. Refresh or retry later.', { cause: error });
    if (error instanceof TypeError) throw new DOMException('Download metadata could not be reached. Retry when connected.', 'NetworkError');
    throw error;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function catalogIndex(pack: InstalledPack): Promise<CatalogEntry[]> {
  if (pack.manifest.kind !== 'pfaf') throw new Error('A PFAF catalog is required.');
  const file = pack.manifest.files.find(file => file.url === (pack.manifest as CatalogManifest).indexFile);
  if (!file) throw new Error('The catalog index is missing. Reinstall the catalog.');
  return validateCatalogIndex(await (await readAsset(pack, file)).json(), pack.manifest);
}
