// Tiny fabricated installation fixtures. They never represent a runnable model.
import { createHash } from 'node:crypto';
import promptDocument from '../../tools/plant_assets/prompts.json' with { type: 'json' };
import type { AssetFile, CatalogEntry, CatalogManifest, ModelManifest } from '../../src/assets/manifest';

export const MANIFEST_URL = 'https://plants.test/packs/pfaf/test/manifest.json';
export const MODEL_URL = 'https://plants.test/packs/bioclip2/test/manifest.json';
export const PREPROCESS = {
  alpha: 'composite on white before resizing', color: 'RGB; decoded channels interpreted as sRGB; embedded ICC ignored',
  crop: '224 center crop; Python round-to-even offsets',
  interpolation: 'Pillow bicubic antialias; a=-0.5; 22-bit coefficients; uint8 between passes',
  layout: 'NCHW', mean: [0.48145466, 0.4578275, 0.40821073], orientation: 'EXIF transpose once',
  resize: 'shortest-side to 224; floor other side', scale: 'uint8 / 255', size: 224,
  std: [0.26862954, 0.26130258, 0.27577711],
};
export const INDEX: CatalogEntry[] = Array.from({ length: 5 }, (_, i) => ({
  id: `taxon-${i}`, scientificName: `Fixture ${i}`, commonName: '', detailFile: 'details.json',
}));
export const CONTENT = new Map<string, Uint8Array>();

export function asset(url: string, content: string | Uint8Array): AssetFile {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  CONTENT.set(url, bytes);
  return { url, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function catalog(id = 'fixture-catalog', text = 'fixture detail'): CatalogManifest {
  return {
    schemaVersion: 1, kind: 'pfaf', id, name: 'Tiny fabricated catalog', taxonCount: INDEX.length,
    sourceSha256: 'f'.repeat(64), exportedAt: '2026-10-17T00:00:00Z', attribution: 'Fabricated test data',
    sourceUrl: 'https://example.test/source', termsUrl: 'https://example.test/terms', indexFile: 'index.json',
    files: [asset('index.json', JSON.stringify(INDEX)), asset('details.json', JSON.stringify(Object.fromEntries(INDEX.map(entry => [entry.id, {
      id: entry.id, sourceKey: entry.scientificName, fields: { latin_name: entry.scientificName, common_name: entry.commonName, note: text }, uses: [],
    }]))))],
  };
}

export function model(): ModelManifest {
  const weights = asset('image.onnx', 'not a model');
  const vectorBytes = new Uint8Array(5 * 768 * 4);
  const vectors = new Float32Array(vectorBytes.buffer);
  for (let row = 0; row < 5; row++) vectors[row * 768 + row] = 1;
  const vectorFile = asset('vectors.f32', vectorBytes);
  const rows = asset('rows.json', JSON.stringify(INDEX.map(entry => entry.id)));
  const runtime = [asset('../../../runtime/1.30.0/ort-wasm-simd-threaded.asyncify.mjs', 'not runtime JS'), asset('../../../runtime/1.30.0/ort-wasm-simd-threaded.asyncify.wasm', 'not WASM')];
  const revision = '2957b322090f9cb17ae72c71981c7218a28d81e0';
  return {
    schemaVersion: 1, kind: 'bioclip2', id: 'fixture-model', name: 'Tiny fabricated model fixture',
    files: [weights, vectorFile, rows, ...runtime],
    model: {
      repository: 'imageomics/bioclip-2', revision,
      checkpointSha256: 'b7b2bf6fbc95799e42630e394cf95803892ab447c1a8ab629dbc82fbeaf7dfef',
      precision: 'FP16 matrix storage with FP32 arithmetic and input/output', dimension: 768,
      inputName: 'images', outputName: 'embedding', inputShape: [1, 3, 224, 224], outputShape: [1, 768], file: weights,
    },
    catalog: { id: 'fixture-catalog', sourceSha256: 'f'.repeat(64), url: '../../pfaf/test/manifest.json', taxonCount: 5, fullTaxonCount: 5, rows },
    vectors: { file: vectorFile, shape: [5, 768], dtype: 'float32', byteOrder: 'little' },
    preprocessing: { ...PREPROCESS, sha256: createHash('sha256').update(JSON.stringify(PREPROCESS)).digest('hex'), hashSerialization: 'sorted-key compact UTF-8 JSON' },
    prompts: {
      templates: [...promptDocument.templates], sha256: '1ca847c6a7b08b97797e593a6361d1a69ae81f9c7130e2bd01472e0538824139',
      tokenizer: `imageomics/bioclip-2@${revision}`, normalization: 'normalize prompts; mean; normalize mean',
    },
    scoring: { version: 1, policy: 'single-photo cosine', rejection: 'disabled; candidate-only' },
    runtime: { version: '1.30.0', files: runtime },
  };
}

export function externalModel(): ModelManifest {
  const manifest = model();
  const weights = manifest.model.file;
  const graph = asset('image.external.onnx', 'not a graph');
  manifest.model.file = graph;
  manifest.model.externalData = [{ path: 'weights.onnx', file: weights }];
  manifest.runtime.files = manifest.runtime.files.map(file =>
    asset(file.url.replace('.asyncify.', '.jspi.'), CONTENT.get(file.url)!));
  manifest.files = [graph, weights, manifest.vectors.file, manifest.catalog.rows, ...manifest.runtime.files];
  return manifest;
}
