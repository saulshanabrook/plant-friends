import { sha256 } from '@noble/hashes/sha2.js';

export interface AssetFile { url: string; sha256: string; bytes: number }
export interface CatalogEntry { id: string; scientificName: string; commonName: string; detailFile: string }
export interface PlantRecord {
  id: string; sourceKey: string;
  fields: Record<string, string | number | null>;
  uses: { category: string; name: string; description: string | null }[];
}
export interface CatalogManifest {
  schemaVersion: 1; kind: 'pfaf'; id: string; name: string; taxonCount: number;
  sourceSha256: string; exportedAt: string; attribution: string; sourceUrl: string; termsUrl: string;
  indexFile: string; files: AssetFile[];
}
export interface ModelManifest {
  schemaVersion: 1; kind: 'bioclip2'; id: string; name: string; files: AssetFile[];
  model: {
    repository: string; revision: string; checkpointSha256: string; precision: string;
    dimension: number; inputName: string; outputName: string; inputShape: number[]; outputShape: number[]; file: AssetFile;
    externalData?: { path: string; file: AssetFile }[];
  };
  catalog: { id: string; sourceSha256: string; url: string; taxonCount: number; fullTaxonCount: number; rows: AssetFile };
  vectors: { file: AssetFile; shape: number[]; dtype: string; byteOrder: string };
  preprocessing: { sha256: string; size: number; mean: number[]; std: number[]; [key: string]: unknown };
  prompts: { sha256: string; templates: string[]; tokenizer: string; normalization: string };
  scoring: { version: number; policy: string; rejection: string };
  runtime: { version: string; files: AssetFile[] };
}
export type PackManifest = CatalogManifest | ModelManifest;

export function validateManifest(value: unknown, manifestUrl: string): PackManifest {
  // JSON is untrusted here. Validate nested objects before treating the document
  // as a typed manifest, so recovery never depends on a stray TypeError.
  const object = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
  const text = (item: unknown): item is string => typeof item === 'string' && item.trim().length > 0;
  const digest = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  const file = (item: unknown): item is AssetFile => object(item) && text(item.url) && digest(item.sha256) &&
    Number.isSafeInteger(item.bytes) && (item.bytes as number) > 0;
  let base: URL;
  try { base = new URL(manifestUrl); }
  catch { throw new Error('The offline pack address is invalid. Refresh and retry.'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.href.includes('#') ||
      (typeof location !== 'undefined' && base.origin !== location.origin))
    throw new Error('Offline packs must have an HTTP or HTTPS address on this site.');
  if (!object(value) || value.schemaVersion !== 1 || !['pfaf', 'bioclip2'].includes(value.kind as string) ||
      !text(value.id) || !text(value.name) || !Array.isArray(value.files) || !value.files.length)
    throw new Error('This offline pack has an unsupported manifest. Prepare or download a compatible pack.');
  const seen = new Set<string>();
  let total = 0;
  for (const asset of value.files) {
    if (!file(asset))
      throw new Error('An offline pack file has invalid size or integrity metadata.');
    let url: URL;
    try { url = new URL(asset.url, base); }
    catch { throw new Error('An offline pack file has an invalid address.'); }
    if (url.origin !== base.origin || url.username || url.password || url.href.includes('#') || seen.has(url.href))
      throw new Error('Offline pack files must have unique URLs on this site.');
    seen.add(url.href);
    total += asset.bytes;
    if (!Number.isSafeInteger(total)) throw new Error('The offline pack download size is invalid.');
  }
  const pack = value as unknown as PackManifest;
  if (pack.kind === 'pfaf') {
    if (!Number.isSafeInteger(pack.taxonCount) || pack.taxonCount < 1 || !digest(pack.sourceSha256) ||
        !text(pack.indexFile) || !pack.files.some(f => f.url === pack.indexFile) || !text(pack.attribution) ||
        !text(pack.exportedAt) || !Number.isFinite(Date.parse(pack.exportedAt)) || !text(pack.sourceUrl) || !text(pack.termsUrl))
      throw new Error('The PFAF catalog manifest is incomplete.');
    if (pack.files.some(asset => asset.bytes > 16 * 1024 * 1024))
      throw new Error('Catalog files are too large for offline setup. Export an index and smaller detail files, then retry.');
  } else {
    const policy = {
      alpha: 'composite on white before resizing', color: 'RGB; decoded channels interpreted as sRGB; embedded ICC ignored',
      crop: '224 center crop; Python round-to-even offsets',
      interpolation: 'Pillow bicubic antialias; a=-0.5; 22-bit coefficients; uint8 between passes',
      layout: 'NCHW', mean: [0.48145466, 0.4578275, 0.40821073], orientation: 'EXIF transpose once',
      resize: 'shortest-side to 224; floor other side', scale: 'uint8 / 255', size: 224,
      std: [0.26862954, 0.26130258, 0.27577711],
    };
    if (!object(value.model) || !object(value.catalog) || !object(value.vectors) || !object(value.preprocessing) ||
        !object(value.prompts) || !object(value.runtime) || !object(value.scoring) ||
        pack.model.repository !== 'imageomics/bioclip-2' || pack.model.revision !== '2957b322090f9cb17ae72c71981c7218a28d81e0' ||
        pack.model.checkpointSha256 !== 'b7b2bf6fbc95799e42630e394cf95803892ab447c1a8ab629dbc82fbeaf7dfef' ||
        pack.model.precision !== 'FP16 matrix storage with FP32 arithmetic and input/output' || !text(pack.model.inputName) || !text(pack.model.outputName) ||
        pack.model.dimension !== 768 || JSON.stringify(pack.model.inputShape) !== '[1,3,224,224]' ||
        JSON.stringify(pack.model.outputShape) !== '[1,768]' ||
        !text(pack.catalog.id) || !digest(pack.catalog.sourceSha256) || !text(pack.catalog.url) ||
        !Number.isSafeInteger(pack.catalog.taxonCount) || pack.catalog.taxonCount < 5 ||
        !Number.isSafeInteger(pack.catalog.fullTaxonCount) || pack.catalog.fullTaxonCount < pack.catalog.taxonCount ||
        !file(pack.catalog.rows) || pack.catalog.rows.bytes > 16 * 1024 * 1024 ||
        pack.vectors.dtype !== 'float32' || pack.vectors.byteOrder !== 'little' ||
        JSON.stringify(pack.vectors.shape) !== JSON.stringify([pack.catalog.taxonCount, 768]) ||
        !file(pack.vectors.file) ||
        pack.vectors.file.bytes !== pack.catalog.taxonCount * 768 * 4 ||
        Object.entries(policy).some(([key, expected]) => JSON.stringify(pack.preprocessing[key]) !== JSON.stringify(expected)) ||
        pack.preprocessing.hashSerialization !== 'sorted-key compact UTF-8 JSON' ||
        !digest(pack.preprocessing.sha256) || !digest(pack.prompts.sha256) || !Array.isArray(pack.prompts.templates) ||
        !pack.prompts.templates.length || pack.prompts.templates.some(template => !text(template) || !template.includes('{name}') ||
          /[^\x20-\x7e]/.test(template) || /[{}]/.test(template.replaceAll('{name}', ''))) ||
        pack.prompts.tokenizer !== `${pack.model.repository}@${pack.model.revision}` ||
        pack.prompts.normalization !== 'normalize prompts; mean; normalize mean' ||
        !Array.isArray(pack.runtime.files) || !pack.runtime.files.length || !text(pack.runtime.version) ||
        pack.scoring.policy !== 'single-photo cosine' || pack.scoring.version !== 1 || pack.scoring.rejection !== 'disabled; candidate-only')
      throw new Error('The encoder, catalog, preprocessing, or vectors are incompatible. Reinstall a matching pack.');
    const hash = (item: unknown): string => Array.from(sha256(new TextEncoder().encode(JSON.stringify(item))), b => b.toString(16).padStart(2, '0')).join('');
    if (pack.preprocessing.sha256 !== hash(policy) || pack.prompts.sha256 !== hash(pack.prompts.templates) ||
        pack.prompts.sha256 !== '1ca847c6a7b08b97797e593a6361d1a69ae81f9c7130e2bd01472e0538824139')
      throw new Error('Preprocessing or prompt integrity metadata differs from its recipe. Rebuild a matching pack.');
    let catalogUrl: URL;
    try { catalogUrl = new URL(pack.catalog.url, base); }
    catch { throw new Error('The identification pack has an invalid catalog address.'); }
    if (catalogUrl.origin !== base.origin || catalogUrl.username || catalogUrl.password || catalogUrl.href.includes('#'))
      throw new Error('The identification pack must reference a catalog on this site.');
    const externalData = pack.model.externalData;
    if (externalData !== undefined && (!Array.isArray(externalData) || externalData.some(entry => !object(entry) ||
        !text(entry.path) || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(entry.path) ||
        entry.path.split('/').some(segment => segment === '.' || segment === '..') || !file(entry.file))))
      throw new Error('The encoder external data has an invalid file or relative path. Rebuild and reinstall a matching pack.');
    for (const required of [pack.model.file, pack.vectors.file, pack.catalog.rows, ...pack.runtime.files,
      ...(externalData ?? []).map(entry => entry.file)]) {
      if (!file(required) || !pack.files.some(f => f.url === required.url && f.bytes === required.bytes && f.sha256 === required.sha256))
        throw new Error('An offline pack is missing a required model or runtime file.');
    }
    const jspi = !!externalData?.length;
    if (jspi) {
      const paths = new Set<string>();
      const urls = new Set<string>([new URL(pack.model.file.url, base).href]);
      for (const entry of externalData!) {
        const url = new URL(entry.file.url, base);
        if (paths.has(entry.path) || urls.has(url.href) || url.search)
          throw new Error('Encoder external data needs unique paths and file URLs without query parameters. Rebuild and reinstall it.');
        paths.add(entry.path); urls.add(url.href);
      }
      if (pack.model.file.bytes > 16 * 1024 * 1024)
        throw new Error('The external-data encoder needs a small graph of at most 16 MiB. Rebuild and reinstall it.');
    }
    const runtimeVariant = jspi ? 'jspi' : 'asyncify';
    const runtimeLabel = jspi ? 'JSPI' : 'Asyncify';
    const runtimeUrls = pack.runtime.files.map(asset => new URL(asset.url, base));
    const runtimeNames = new Set(runtimeUrls.map(url => url.pathname.slice(url.pathname.lastIndexOf('/') + 1)));
    if (runtimeUrls.length !== 2 || new Set(runtimeUrls.map(url => new URL('.', url).href)).size !== 1 ||
        runtimeUrls.some(url => !new URL('.', url).pathname.endsWith(`/runtime/${encodeURIComponent(pack.runtime.version)}/`)) ||
        runtimeUrls.some(url => url.search) || !runtimeNames.has(`ort-wasm-simd-threaded.${runtimeVariant}.mjs`) ||
        !runtimeNames.has(`ort-wasm-simd-threaded.${runtimeVariant}.wasm`))
      throw new Error(`The offline runtime needs exactly the native WebGPU ${runtimeLabel} JavaScript/WASM pair in one versioned directory. Rebuild and reinstall it.`);
  }
  return pack;
}

export function validateCatalogIndex(value: unknown, manifest: CatalogManifest): CatalogEntry[] {
  if (!Array.isArray(value) || value.length !== manifest.taxonCount)
    throw new Error('The downloaded catalog index is incompatible. Reinstall the catalog.');
  const ids = new Set<string>();
  const details = new Map<string, number>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id) ||
        typeof entry.scientificName !== 'string' || !entry.scientificName.trim() || typeof entry.commonName !== 'string' ||
        typeof entry.detailFile !== 'string' || entry.detailFile === manifest.indexFile ||
        !manifest.files.some(file => file.url === entry.detailFile))
      throw new Error('The downloaded catalog index has an invalid plant or detail reference. Reinstall it.');
    ids.add(entry.id);
    details.set(entry.detailFile, (details.get(entry.detailFile) ?? 0) + 1);
  }
  if (manifest.files.some(file => file.url !== manifest.indexFile && !details.has(file.url)) ||
      [...details.values()].some(count => count > 256))
    throw new Error('The catalog needs complete detail files of at most 256 plants. Rebuild and reinstall it.');
  return value as CatalogEntry[];
}

export function validateCatalogDetails(value: unknown, index: CatalogEntry[], detailFile: string): Record<string, PlantRecord> {
  const entries = index.filter(entry => entry.detailFile === detailFile);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== entries.length)
    throw new Error('A catalog detail file is incomplete or malformed. Reinstall the catalog.');
  const records = value as Record<string, PlantRecord>;
  for (const entry of entries) {
    const record = Object.hasOwn(records, entry.id) ? records[entry.id] : null;
    if (!record || typeof record !== 'object' || record.id !== entry.id || record.sourceKey !== entry.scientificName ||
        !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields) || record.fields.latin_name !== record.sourceKey ||
        Object.values(record.fields).some(field => field !== null && typeof field !== 'string' && (typeof field !== 'number' || !Number.isFinite(field))) ||
        !Array.isArray(record.uses) || record.uses.some(use => !use || typeof use !== 'object' ||
          typeof use.category !== 'string' || typeof use.name !== 'string' || (use.description !== null && typeof use.description !== 'string')))
      throw new Error('A catalog detail does not match its plant record or fields. Rebuild and reinstall the catalog.');
    for (const field of ['edibility_rating', 'medicinal_rating', 'other_uses_rating']) {
      const rating = record.fields[field];
      if (rating !== undefined && rating !== null && (typeof rating !== 'number' || rating < 0 || rating > 5))
        throw new Error('A catalog plant rating is invalid. Rebuild and reinstall the catalog.');
    }
  }
  return records;
}

export function validateVectors(vectors: Float32Array, rows: unknown, manifest: ModelManifest, catalog: CatalogManifest, index: CatalogEntry[]): string[] {
  if (catalog.id !== manifest.catalog.id || catalog.sourceSha256 !== manifest.catalog.sourceSha256 ||
      catalog.taxonCount !== manifest.catalog.fullTaxonCount || !Array.isArray(rows) ||
      rows.length !== manifest.catalog.taxonCount || vectors.length !== rows.length * 768 ||
      new Set(rows).size !== rows.length || !Array.isArray(index) || index.length !== catalog.taxonCount ||
      index.some(entry => !entry || typeof entry.id !== 'string') || new Set(index.map(entry => entry.id)).size !== index.length)
    throw new Error('The downloaded identification pack belongs to a different catalog. Reinstall it.');
  const valid = new Set(index.map(entry => entry.id));
  for (let r = 0; r < rows.length; r++) {
    if (typeof rows[r] !== 'string' || !valid.has(rows[r])) throw new Error('An identification row has no PFAF record.');
    let squared = 0;
    for (let c = 0; c < 768; c++) {
      const value = vectors[r * 768 + c];
      if (!Number.isFinite(value)) throw new Error('Catalog vectors contain invalid values. Reinstall the pack.');
      squared += value * value;
    }
    if (Math.abs(Math.sqrt(squared) - 1) > 1e-4) throw new Error('Catalog vectors are not normalized. Rebuild the pack.');
  }
  return rows as string[];
}
