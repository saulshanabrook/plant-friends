import { availablePack, catalogIndex } from '../assets/source';
import { installPack, installedPack, readAsset, type DownloadProgress } from '../assets/storage';
import type { PlantRecord } from '../assets/manifest';
import { InferenceClient } from '../inference/client';
import type { InferenceResult, RuntimeInfo } from '../inference/protocol';

export function createDiagnostics(onStatus: (status: string) => void) {
  let client: InferenceClient | null = null;
  let info: RuntimeInfo | null = null;
  return {
    async install(kind: 'pfaf' | 'bioclip2') {
      const available = await availablePack(kind);
      const controller = new AbortController();
      let last = 0;
      const receipt = await installPack(available.manifestUrl, available.manifest, controller.signal, (value: DownloadProgress) => {
        const now = performance.now();
        if (now - last > 100 || value.received === value.total) {
          onStatus(`${kind}: ${(value.received / 1024 / 1024).toFixed(1)} / ${(value.total / 1024 / 1024).toFixed(1)} MiB`);
          last = now;
        }
      });
      onStatus(`${available.manifest.name} installed.`);
      return { id: receipt.manifest.id, bytes: receipt.manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
    },
    async load(options: { diagnostics?: boolean } = {}) {
      const model = await installedPack('bioclip2');
      const catalog = await installedPack('pfaf');
      if (!model || !catalog) throw new Error('Install the catalog and model before running the real inference check.');
      const index = await catalogIndex(catalog);
      client?.dispose();
      client = new InferenceClient();
      info = await client.load(model, catalog, index, options);
      onStatus('Real BioCLIP 2 session loaded.');
      return info;
    },
    async identifyPhoto(photo: Blob): Promise<InferenceResult> {
      if (!client) throw new Error('Load the model first.');
      return client.identify(photo);
    },
    async identifyFixture(filename: string): Promise<InferenceResult> {
      if (!client) throw new Error('Load the model first.');
      if (!/^[\w.-]+$/.test(filename)) throw new Error('Invalid fixture filename.');
      const response = await fetch(`${import.meta.env.BASE_URL}fixtures/photos/${filename}`);
      if (!response.ok) throw new Error('Fetch the pinned licensed fixtures first.');
      return client.identify(await response.blob());
    },
    async identifyTensor(tensor: Float32Array): Promise<InferenceResult> {
      if (!client) throw new Error('Load the model first.');
      return client.identify(tensor);
    },
    async profilePhoto(photo: Blob): Promise<InferenceResult> {
      if (!client) throw new Error('Load the model first.');
      return client.identify(photo, { profile: true });
    },
    async detail(id: string): Promise<PlantRecord> {
      const catalog = await installedPack('pfaf');
      if (!catalog) throw new Error('Install the catalog first.');
      const index = await catalogIndex(catalog);
      const entry = index.find(entry => entry.id === id);
      const file = catalog.manifest.files.find(file => file.url === entry?.detailFile);
      if (!file) throw new Error('No such PFAF entry.');
      const records = await (await readAsset(catalog, file)).json() as Record<string, PlantRecord>;
      return records[id];
    },
    dispose() { client?.dispose(); client = null; info = null; },
  };
}

declare global {
  interface Window { plantFriends: ReturnType<typeof createDiagnostics> }
}
