import type { CatalogEntry, CatalogManifest, PackManifest } from './manifest';
import { validateManifest, validateCatalogIndex } from './manifest';
import { installedPack, readAsset, type InstalledPack } from './storage';

export async function availablePack(kind: PackManifest['kind']): Promise<{ manifestUrl: string; manifest: PackManifest }> {
  if (!navigator.onLine) {
    const installed = await installedPack(kind);
    if (installed) return installed;
    throw new Error('This pack has not been installed. Connect to download it first.');
  }
  try {
    const pointerUrl = new URL(`${import.meta.env.BASE_URL}${kind === 'pfaf' ? 'catalog' : 'model'}.json`, location.origin);
    const pointerResponse = await fetch(pointerUrl, { cache: 'no-cache' });
    if (!pointerResponse.ok) throw new Error('No prepared pack is available on this host.');
    const pointer = await pointerResponse.json();
    if (typeof pointer.url !== 'string') throw new Error('The offline-pack pointer is invalid.');
    const manifestUrl = new URL(pointer.url, pointerUrl).href;
    if (new URL(manifestUrl).origin !== location.origin) throw new Error('Offline packs must be hosted on this site.');
    const response = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error('The prepared offline pack could not be loaded.');
    const manifest = validateManifest(await response.json(), manifestUrl);
    if (manifest.kind !== kind) throw new Error('The host points to the wrong offline pack.');
    return { manifestUrl, manifest };
  } catch (error) {
    const installed = await installedPack(kind);
    if (installed) return installed;
    throw error;
  }
}

export async function catalogIndex(pack: InstalledPack): Promise<CatalogEntry[]> {
  if (pack.manifest.kind !== 'pfaf') throw new Error('A PFAF catalog is required.');
  const file = pack.manifest.files.find(file => file.url === (pack.manifest as CatalogManifest).indexFile);
  if (!file) throw new Error('The catalog index is missing. Reinstall the catalog.');
  return validateCatalogIndex(await (await readAsset(pack, file)).json(), pack.manifest);
}
