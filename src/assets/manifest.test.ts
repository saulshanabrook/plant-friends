import { describe, expect, test } from 'vitest';
import { validateManifest, validateVectors, validateCatalogIndex, validateCatalogDetails } from './manifest';
import { asset, catalog, model, externalModel, MANIFEST_URL, MODEL_URL, INDEX, CONTENT } from '../../tests/assets/fixtures';

describe('untrusted manifest compatibility', () => {
  test('accepts a complete catalog and the pinned supported encoder contract', () => {
    expect(validateManifest(catalog(), MANIFEST_URL).kind).toBe('pfaf');
    expect(validateManifest(model(), MODEL_URL).kind).toBe('bioclip2');
    const legacy = model(); legacy.model.externalData = [];
    expect(validateManifest(legacy, MODEL_URL)).toBe(legacy);
    const external = externalModel();
    expect(validateManifest(external, MODEL_URL)).toBe(external);
  });

  test.each([null, {}, 'weights.onnx', [null], [{}], [{ path: 'weights.onnx', file: null }]])('rejects malformed external data: %j', externalData => {
    const pack = { ...externalModel(), model: { ...externalModel().model, externalData } };
    expect(() => validateManifest(pack, MODEL_URL)).toThrow('external data');
    try { validateManifest(pack, MODEL_URL); } catch (error) { expect(error).not.toBeInstanceOf(TypeError); }
  });

  test.each(['', '.', '..', './weights.onnx', '../weights.onnx', 'a/../weights.onnx', '/weights.onnx',
    'https://elsewhere.test/weights.onnx', 'a\\weights.onnx', 'weights.onnx?x=1', 'weights.onnx#x', '%77eights.onnx'])('rejects a noncanonical external data path: %s', path => {
    const pack = externalModel(); pack.model.externalData![0].path = path;
    expect(() => validateManifest(pack, MODEL_URL)).toThrow('relative path');
  });

  test('requires external descriptors to be included exactly and use unique paths and file URLs', () => {
    const missing = externalModel(); missing.files = missing.files.filter(file => file !== missing.model.externalData![0].file);
    expect(() => validateManifest(missing, MODEL_URL)).toThrow('missing a required');
    const changed = externalModel();
    changed.model.externalData![0].file = { ...changed.model.externalData![0].file, sha256: '0'.repeat(64) };
    expect(() => validateManifest(changed, MODEL_URL)).toThrow('missing a required');
    const duplicate = externalModel(); duplicate.model.externalData!.push({ ...duplicate.model.externalData![0] });
    expect(() => validateManifest(duplicate, MODEL_URL)).toThrow('unique paths');
    const sameFile = externalModel(); sameFile.model.externalData!.push({ ...sameFile.model.externalData![0], path: 'alias.onnx' });
    expect(() => validateManifest(sameFile, MODEL_URL)).toThrow('unique paths');
    const samePath = externalModel();
    const otherFile = asset('other-weights.onnx', 'other weights');
    samePath.files.push(otherFile); samePath.model.externalData!.push({ path: 'weights.onnx', file: otherFile });
    expect(() => validateManifest(samePath, MODEL_URL)).toThrow('unique paths');
    const graph = externalModel(); graph.model.externalData![0].file = graph.model.file;
    expect(() => validateManifest(graph, MODEL_URL)).toThrow('unique paths');
    const query = externalModel(); query.model.externalData![0].file.url += '?alias';
    expect(() => validateManifest(query, MODEL_URL)).toThrow('without query');
    const foreign = externalModel(); foreign.model.externalData![0].file.url = 'https://elsewhere.test/weights.onnx';
    expect(() => validateManifest(foreign, MODEL_URL)).toThrow('on this site');
  });

  test('external data requires the exact JSPI pair and a bounded graph without changing precision', () => {
    const asyncify = externalModel();
    for (const runtime of asyncify.runtime.files) runtime.url = runtime.url.replace('.jspi.', '.asyncify.');
    expect(() => validateManifest(asyncify, MODEL_URL)).toThrow('native WebGPU JSPI');
    const legacy = externalModel(); legacy.model.externalData = [];
    expect(() => validateManifest(legacy, MODEL_URL)).toThrow('native WebGPU Asyncify');
    const mixed = externalModel(); mixed.runtime.files[0].url = mixed.runtime.files[0].url.replace('.jspi.', '.asyncify.');
    expect(() => validateManifest(mixed, MODEL_URL)).toThrow('native WebGPU JSPI');
    const large = externalModel(); large.model.file.bytes = 16 * 1024 * 1024 + 1;
    expect(() => validateManifest(large, MODEL_URL)).toThrow('small graph');
    const precision = externalModel(); precision.model.precision = 'FP16 with FP32 input/output';
    expect(() => validateManifest(precision, MODEL_URL)).toThrow('incompatible');
  });

  test.each([null, [], {}, { schemaVersion: 2 }, { ...catalog(), files: [null] },
    { ...catalog(), files: [{ url: {}, bytes: 3, sha256: 'f'.repeat(64) }] }])('malformed JSON fails with a recovery error: %j', value => {
    expect(() => validateManifest(value, MANIFEST_URL)).toThrow(/manifest|metadata/);
    try { validateManifest(value, MANIFEST_URL); } catch (error) { expect(error).not.toBeInstanceOf(TypeError); }
  });

  test.each(['model', 'catalog', 'vectors', 'preprocessing', 'prompts', 'runtime', 'scoring'])('a malformed nested %s never throws a generic TypeError', key => {
    for (const value of [null, [], {}, 'invalid']) {
      expect(() => validateManifest({ ...model(), [key]: value }, MODEL_URL)).toThrow(/incompatible|required|runtime/);
    }
  });

  test('rejects missing descriptors, escaped origins, duplicate canonical URLs and unsafe totals', () => {
    const missing = model();
    delete (missing.model as Partial<typeof missing.model>).file;
    expect(() => validateManifest(missing, MODEL_URL)).toThrow('missing a required');
    const external = catalog(); external.files[0].url = 'https://elsewhere.test/index.json';
    expect(() => validateManifest(external, MANIFEST_URL)).toThrow('on this site');
    const duplicates = catalog(); duplicates.files.push({ ...duplicates.files[0], url: './index.json' });
    expect(() => validateManifest(duplicates, MANIFEST_URL)).toThrow('unique URLs');
    const unsafe = catalog(); unsafe.files = unsafe.files.map(file => ({ ...file, bytes: Number.MAX_SAFE_INTEGER }));
    expect(() => validateManifest(unsafe, MANIFEST_URL)).toThrow('size is invalid');
    expect(() => validateManifest(catalog(), 'file:///tmp/manifest.json')).toThrow('HTTP');
    expect(() => validateManifest(catalog(), 'bad-url')).toThrow('address is invalid');
  });

  test.each(['mean', 'std', 'orientation', 'color', 'alpha', 'interpolation', 'crop', 'layout', 'resize', 'scale', 'sha256', 'hashSerialization'])('unsupported preprocessing %s fails before inference', key => {
    const pack = model(); pack.preprocessing[key] = 'incompatible';
    expect(() => validateManifest(pack, MODEL_URL)).toThrow(/incompatible|integrity/);
  });

  test('rejects altered prompts, mismatched tokenizer/revision and incompatible catalog/vector shape', () => {
    const prompt = model(); prompt.prompts.templates[0] = 'a different {name}';
    expect(() => validateManifest(prompt, MODEL_URL)).toThrow('recipe');
    const tokenizer = model(); tokenizer.prompts.tokenizer = 'another revision';
    expect(() => validateManifest(tokenizer, MODEL_URL)).toThrow('incompatible');
    const revision = model(); revision.model.revision = 'a'.repeat(40);
    expect(() => validateManifest(revision, MODEL_URL)).toThrow('incompatible');
    const count = model(); count.catalog.fullTaxonCount = 4;
    expect(() => validateManifest(count, MODEL_URL)).toThrow('incompatible');
    const shape = model(); shape.vectors.file.bytes++;
    expect(() => validateManifest(shape, MODEL_URL)).toThrow('incompatible');
  });

  test('runtime JS/WASM must share a versioned directory and be explicitly included', () => {
    const pack = model(); pack.runtime.files = [];
    expect(() => validateManifest(pack, MODEL_URL)).toThrow('incompatible');
    const mixed = model(); mixed.runtime.files[1].url = '../../../runtime/old/runtime.wasm';
    expect(() => validateManifest(mixed, MODEL_URL)).toThrow('versioned directory');
    const absent = model(); absent.files.pop();
    expect(() => validateManifest(absent, MODEL_URL)).toThrow('missing a required');
  });

  test('rejects legacy whole-graph FP16 precision before installation', () => {
    const legacy = model(); legacy.model.precision = 'FP16 with FP32 input/output';
    expect(() => validateManifest(legacy, MODEL_URL)).toThrow('incompatible');
  });

  test.each(['jsep', 'generic', 'extra', 'query'])('rejects a same-version %s runtime instead of the exact native Asyncify pair', variant => {
    const pack = model();
    if (variant === 'extra') {
      const extra = asset('../../../runtime/1.30.0/ort-wasm-simd-threaded.jsep.mjs', 'old runtime');
      pack.runtime.files.push(extra); pack.files.push(extra);
    } else {
      for (const runtime of pack.runtime.files) {
        if (variant === 'jsep') runtime.url = runtime.url.replace('.asyncify.', '.jsep.');
        if (variant === 'generic') runtime.url = runtime.url.replace('ort-wasm-simd-threaded.asyncify.', 'runtime.');
        if (variant === 'query') runtime.url += '?old=1';
      }
    }
    expect(() => validateManifest(pack, MODEL_URL)).toThrow('native WebGPU Asyncify');
  });
});

describe('catalog semantic integrity', () => {
  test('accepts the full index and its exact detail mapping, preserving zero and null fields', () => {
    const pack = catalog();
    expect(model().preprocessing.sha256).toBe('b09f51af341c7b946e0d926d2be163141466de083009c73dcc6bbf632feb319a');
    expect(validateCatalogIndex(INDEX, pack)).toEqual(INDEX);
    const details = JSON.parse(new TextDecoder().decode(CONTENT.get('details.json')));
    details['taxon-0'].fields.edibility_rating = 0;
    details['taxon-0'].fields.medicinal_rating = null;
    expect(validateCatalogDetails(details, INDEX, 'details.json')['taxon-0'].fields.edibility_rating).toBe(0);
    expect(validateCatalogDetails(details, INDEX, 'details.json')['taxon-0'].fields.medicinal_rating).toBeNull();
  });
  test('rejects malformed index entries and absent detail references', () => {
    expect(() => validateCatalogIndex([null, ...INDEX.slice(1)], catalog())).toThrow('index');
    expect(() => validateCatalogIndex([{ ...INDEX[0], detailFile: 'absent.json' }, ...INDEX.slice(1)], catalog())).toThrow('detail reference');
    expect(() => validateCatalogIndex([INDEX[0], ...INDEX.slice(0, 4)], catalog())).toThrow('index');
  });
  test('rejects detail mismatch, missing/foreign records, malformed fields and bad uses/ratings', () => {
    catalog();
    const original = JSON.parse(new TextDecoder().decode(CONTENT.get('details.json')));
    for (const value of [null, [], {}, { ...original, foreign: original['taxon-0'] }])
      expect(() => validateCatalogDetails(value, INDEX, 'details.json')).toThrow('detail file');
    for (const mutation of [
      { sourceKey: 'wrong source name' }, { fields: null }, { fields: { latin_name: 'Fixture 0', invalid: true } },
      { uses: [null] }, { fields: { latin_name: 'Fixture 0', edibility_rating: 6 } },
    ]) {
      const details = structuredClone(original);
      Object.assign(details['taxon-0'], mutation);
      expect(() => validateCatalogDetails(details, INDEX, 'details.json')).toThrow(/detail|rating/);
    }
  });
});

describe('catalog-vector compatibility', () => {
  const unitVectors = () => {
    const vectors = new Float32Array(5 * 768);
    for (let row = 0; row < 5; row++) vectors[row * 768 + row] = 1;
    return vectors;
  };
  test('accepts finite unit vectors and an exact one-to-one row mapping', () => {
    expect(validateVectors(unitVectors(), INDEX.map(row => row.id), model(), catalog(), INDEX)).toEqual(INDEX.map(row => row.id));
  });
  test('rejects wrong catalog identity/count, duplicate/unknown rows and malformed index', () => {
    const rows = INDEX.map(row => row.id);
    expect(() => validateVectors(unitVectors(), rows, model(), catalog('other'), INDEX)).toThrow('different catalog');
    expect(() => validateVectors(unitVectors(), [rows[0], ...rows.slice(0, 4)], model(), catalog(), INDEX)).toThrow('different catalog');
    expect(() => validateVectors(unitVectors(), ['unknown', ...rows.slice(1)], model(), catalog(), INDEX)).toThrow('no PFAF record');
    expect(() => validateVectors(unitVectors(), rows, model(), catalog(), [null] as never)).toThrow('different catalog');
  });
  test('rejects invalid values and non-unit vectors', () => {
    const rows = INDEX.map(row => row.id);
    const invalid = unitVectors(); invalid[1] = NaN;
    expect(() => validateVectors(invalid, rows, model(), catalog(), INDEX)).toThrow('invalid values');
    const unnormalized = unitVectors(); unnormalized[0] = 2;
    expect(() => validateVectors(unnormalized, rows, model(), catalog(), INDEX)).toThrow('not normalized');
  });
});
