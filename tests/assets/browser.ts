import { ASSET_CACHE, installPack, installedPack, readAsset, deletePack } from '../../src/assets/storage';
import type { AssetFile, CatalogManifest, PackManifest } from '../../src/assets/manifest';
import type { DownloadProgress } from '../../src/assets/storage';

const manifestUrl = new URL('/tests/assets/downloads/manifest.json', location.origin).href;

const harness = {
  ASSET_CACHE,
  manifestUrl,
  installedPack,
  readAsset,
  deletePack,
  progress: [] as DownloadProgress[],
  async catalog(id: string, detail: string): Promise<{ manifest: CatalogManifest; files: Record<string, string> }> {
    const index = Array.from({ length: 5 }, (_, i) => ({ id: `fixture-${i}`, scientificName: `Fixture ${i}`, commonName: '', detailFile: '/tests/assets/downloads/details.json' }));
    const files: Record<string, string> = {
      '/tests/assets/downloads/index.json': JSON.stringify(index),
      '/tests/assets/downloads/details.json': JSON.stringify(Object.fromEntries(index.map(entry => [entry.id, {
        id: entry.id, sourceKey: entry.scientificName, fields: { latin_name: entry.scientificName, common_name: entry.commonName, note: detail }, uses: [],
      }]))),
    };
    const descriptors: AssetFile[] = [];
    for (const [url, text] of Object.entries(files)) {
      const bytes = new TextEncoder().encode(text);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      descriptors.push({ url, bytes: bytes.byteLength, sha256: Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('') });
    }
    return {
      files,
      manifest: {
        schemaVersion: 1, kind: 'pfaf', id, name: 'Fabricated catalog for browser storage checks', taxonCount: 5,
        sourceSha256: 'f'.repeat(64), exportedAt: '2026-10-17T00:00:00Z', attribution: 'Fabricated test data',
        sourceUrl: 'https://example.test/source', termsUrl: 'https://example.test/terms',
        indexFile: '/tests/assets/downloads/index.json', files: descriptors,
      },
    };
  },
  async install(manifest: PackManifest, cancelFile?: string): Promise<{ ok: boolean; error?: string; name?: string }> {
    const controller = new AbortController();
    this.progress = [];
    try {
      await installPack(manifestUrl, manifest, controller.signal, progress => {
        this.progress.push(progress);
        if (progress.file === cancelFile && progress.phase === 'downloading') controller.abort();
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), name: error instanceof Error ? error.name : undefined };
    }
  },
  async detail(): Promise<string | null> {
    const pack = await installedPack('pfaf');
    return pack ? (await (await readAsset(pack, pack.manifest.files[1])).json())['fixture-0'].fields.note : null;
  },
};

declare global { interface Window { assetHarness: typeof harness } }
window.assetHarness = harness;
