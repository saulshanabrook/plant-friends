import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { InstalledPack } from '../assets/storage';
import type { WorkerCommand, WorkerReply } from './protocol';
import { asset, catalog, CONTENT, externalModel, INDEX, MANIFEST_URL, model, MODEL_URL } from '../../tests/assets/fixtures';

// These doubles exercise the real module's IPC and activation state. The tiny
// fixture encoder is fabricated; these tests provide no GPU/numerical evidence.
const doubles = vi.hoisted(() => ({
  readAsset: vi.fn(), preparePhoto: vi.fn(), createSession: vi.fn(),
  createJspiSession: vi.fn(),
  run: vi.fn(), release: vi.fn(), inputDispose: vi.fn(), outputDispose: vi.fn(),
  env: { wasm: {}, webgpu: { adapter: undefined as unknown }, versions: { web: '1.30.0' }, logLevel: 'warning' },
  jspiEnv: { wasm: {}, webgpu: { adapter: undefined as unknown }, versions: { web: '1.30.0' }, logLevel: 'warning' },
}));
vi.mock('onnxruntime-web/jspi', () => ({
  env: doubles.jspiEnv,
  InferenceSession: { create: doubles.createJspiSession },
  Tensor: class {
    dispose = doubles.inputDispose;
    constructor(readonly type: string, readonly data: Float32Array, readonly dims: number[]) {}
  },
}));

vi.mock('../assets/storage', () => ({ readAsset: doubles.readAsset }));
vi.mock('./preprocess', () => ({ preparePhoto: doubles.preparePhoto }));
vi.mock('onnxruntime-web/webgpu', () => ({
  env: doubles.env,
  InferenceSession: { create: doubles.createSession },
  Tensor: class {
    dispose = doubles.inputDispose;
    constructor(readonly type: string, readonly data: Float32Array, readonly dims: number[]) {}
  },
}));

const session = { inputNames: ['images'], outputNames: ['embedding'], run: doubles.run, release: doubles.release };
const assetsByPack = new Map<string, Map<string, Uint8Array>>();
let catalogPack: InstalledPack;
let worker: {
  isSecureContext: boolean;
  onmessage: ((event: { data: WorkerCommand }) => void) | null;
  postMessage: ReturnType<typeof vi.fn<(reply: WorkerReply) => void>>;
};
let requestAdapter: ReturnType<typeof vi.fn>;

// Snapshot each coherent descriptor/content pair because the shared fixture
// factory reuses URLs. Replacement B has valid but different rows AND vectors.
function installedModel(id: string, replacement = false, external = false): InstalledPack {
  const manifest = external ? externalModel() : model();
  manifest.id = id;
  if (replacement) {
    const vectors = new Float32Array(5 * 768);
    vectors[0] = vectors[1] = Math.SQRT1_2;
    for (let row = 1; row < 5; row++) vectors[row * 768 + row] = 1;
    const vectorFile = asset('vectors.f32', new Uint8Array(vectors.buffer));
    const rowsFile = asset('rows.json', JSON.stringify(INDEX.map(entry => entry.id).reverse()));
    manifest.vectors.file = vectorFile;
    manifest.catalog.rows = rowsFile;
    manifest.files = manifest.files.map(file => file.url === vectorFile.url ? vectorFile : file.url === rowsFile.url ? rowsFile : file);
  }
  assetsByPack.set(id, new Map(manifest.files.map(file => [file.url, Uint8Array.from(CONTENT.get(file.url)!)])));
  return { manifestUrl: MODEL_URL, manifest, installedAt: '2026-10-17T00:00:00Z', persistent: false };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  doubles.readAsset.mockReset();
  doubles.createSession.mockReset();
  doubles.createJspiSession.mockReset();
  doubles.env.wasm = {};
  doubles.env.webgpu.adapter = undefined;
  doubles.jspiEnv.wasm = {};
  doubles.jspiEnv.webgpu.adapter = undefined;
  assetsByPack.clear();
  catalogPack = { manifestUrl: MANIFEST_URL, manifest: catalog(), installedAt: '2026-10-17T00:00:00Z', persistent: false };
  doubles.readAsset.mockImplementation(async (pack: InstalledPack, file: { url: string }) => {
    const bytes = assetsByPack.get(pack.manifest.id)?.get(file.url);
    if (!bytes) throw new Error(`Unexpected fixture asset: ${pack.manifest.id}/${file.url}`);
    return new Response(Uint8Array.from(bytes).buffer);
  });
  const embedding = new Float32Array(768);
  embedding[0] = 1;
  doubles.run.mockResolvedValue({ embedding: { data: embedding, dispose: doubles.outputDispose } });
  doubles.createSession.mockResolvedValue(session);
  doubles.createJspiSession.mockResolvedValue(session);
  doubles.preparePhoto.mockResolvedValue(new Float32Array(3 * 224 * 224));
  const device = {
    features: new Set(['shader-f16']), lost: new Promise(() => {}), destroy: vi.fn(),
    queue: { onSubmittedWorkDone: vi.fn().mockResolvedValue(undefined) },
  };
  requestAdapter = vi.fn().mockResolvedValue({
    features: new Set(['shader-f16']),
    info: { vendor: 'fixture', architecture: 'fixture hardware', device: 'fixture', description: 'Explicit GPU double', isFallbackAdapter: false },
    limits: { maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000, maxComputeWorkgroupStorageSize: 16_384, maxComputeInvocationsPerWorkgroup: 256 },
    requestDevice: vi.fn().mockResolvedValue(device),
  });
  worker = { isSecureContext: true, onmessage: null, postMessage: vi.fn<(reply: WorkerReply) => void>() };
  vi.stubGlobal('self', worker);
  vi.stubGlobal('navigator', { gpu: { requestAdapter } });
  vi.stubGlobal('WebAssembly', Object.assign(Object.create(WebAssembly), { Suspending: class {} }));
  vi.stubGlobal('GPUComputePassEncoder', class {
    dispatchWorkgroups() {}
    dispatchWorkgroupsIndirect() {}
  });
  await import('./inference.worker');
});

afterEach(() => vi.unstubAllGlobals());

describe('worker IPC activation with explicit ORT/GPU doubles', () => {
  test('JSPI receives a small graph and the exact cached weights Blob without reading a weights ArrayBuffer', async () => {
    const pack = installedModel('external-model', false, true);
    if (pack.manifest.kind !== 'bioclip2') throw new Error('Unexpected fixture kind');
    const weights = pack.manifest.model.externalData![0];
    const response = new Response(CONTENT.get(weights.file.url)!.slice().buffer);
    const blob = vi.spyOn(response, 'blob');
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('Full weights ArrayBuffer forbidden.'));
    const read = doubles.readAsset.getMockImplementation()!;
    doubles.readAsset.mockImplementation((installed: InstalledPack, file: { url: string }) =>
      file.url === weights.file.url ? Promise.resolve(response) : read(installed, file));

    worker.onmessage!({ data: { type: 'load', id: 20, model: pack, catalog: catalogPack, index: INDEX } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'loaded', id: 20 })));
    expect(doubles.createSession).not.toHaveBeenCalled();
    expect(doubles.createJspiSession).toHaveBeenCalledTimes(1);
    const [graph, options] = doubles.createJspiSession.mock.calls[0];
    expect(new Uint8Array(graph)).toEqual(CONTENT.get(pack.manifest.model.file.url));
    expect(options.externalData).toHaveLength(1);
    expect(options.externalData[0]).toMatchObject({ path: weights.path, data: expect.any(Blob) });
    expect(await options.externalData[0].data.text()).toBe('not a model');
    expect(blob).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(doubles.jspiEnv.wasm).toMatchObject({ numThreads: 1, proxy: false, wasmPaths: {
      mjs: 'https://plants.test/runtime/1.30.0/ort-wasm-simd-threaded.jspi.mjs',
      wasm: 'https://plants.test/runtime/1.30.0/ort-wasm-simd-threaded.jspi.wasm',
    } });
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({
      backend: 'native-webgpu-jspi', modelBytes: pack.manifest.model.file.bytes + weights.file.bytes,
    }) }));
    worker.onmessage!({ data: { type: 'tensor', id: 21, tensor: new Float32Array(3 * 224 * 224) } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', id: 21 })));
  });

  test('missing JSPI fails before asset reads and leaves an active legacy session usable', async () => {
    const legacy = installedModel('legacy');
    worker.onmessage!({ data: { type: 'load', id: 30, model: legacy, catalog: catalogPack, index: INDEX } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'loaded', id: 30 })));
    const reads = doubles.readAsset.mock.calls.length;
    vi.stubGlobal('WebAssembly', {});
    const pack = installedModel('unsupported-jspi', false, true);
    worker.onmessage!({ data: { type: 'load', id: 31, model: pack, catalog: catalogPack, index: INDEX } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', id: 31, code: 'model-initialization', message: expect.stringContaining('needs WebAssembly JSPI'),
    })));
    expect(doubles.readAsset).toHaveBeenCalledTimes(reads);
    expect(doubles.createJspiSession).not.toHaveBeenCalled();
    expect(doubles.release).not.toHaveBeenCalled();
    worker.onmessage!({ data: { type: 'tensor', id: 32, tensor: new Float32Array(3 * 224 * 224) } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'result', id: 32, result: expect.objectContaining({ packId: 'legacy' }),
    })));
  });

  test('JSPI failure reports the actual error and destroys its requested device without falling back', async () => {
    const pack = installedModel('broken-jspi', false, true);
    doubles.createJspiSession.mockRejectedValueOnce(new Error('Explicit JSPI initialization failure.'));
    worker.onmessage!({ data: { type: 'load', id: 40, model: pack, catalog: catalogPack, index: INDEX } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'error', id: 40, code: 'model-initialization', message: 'Explicit JSPI initialization failure.',
    }));
    const adapter = await requestAdapter.mock.results[0].value;
    expect((await adapter.requestDevice.mock.results[0].value).destroy).toHaveBeenCalledTimes(1);
    expect(doubles.createSession).not.toHaveBeenCalled();
  });

  test.each(['missing', 'truncated'])('%s external weights fail before replacing an active legacy session', async failure => {
    const legacy = installedModel('saved-legacy');
    worker.onmessage!({ data: { type: 'load', id: 50, model: legacy, catalog: catalogPack, index: INDEX } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'loaded', id: 50 })));
    const pack = installedModel('unusable-weights', false, true);
    if (pack.manifest.kind !== 'bioclip2') throw new Error('Unexpected fixture kind');
    const weights = pack.manifest.model.externalData![0].file;
    const read = doubles.readAsset.getMockImplementation()!;
    doubles.readAsset.mockImplementation((installed: InstalledPack, file: { url: string }) => {
      if (file.url !== weights.url) return read(installed, file);
      if (failure === 'missing') throw new Error('An offline file is missing or was evicted. Reinstall the downloaded pack.');
      return Promise.resolve(new Response('short'));
    });
    worker.onmessage!({ data: { type: 'load', id: 51, model: pack, catalog: catalogPack, index: INDEX } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', id: 51, message: expect.stringContaining(failure === 'missing' ? 'missing or was evicted' : 'incorrect size'),
    })));
    expect(doubles.createJspiSession).not.toHaveBeenCalled();
    expect(doubles.release).not.toHaveBeenCalled();
    worker.onmessage!({ data: { type: 'tensor', id: 52, tensor: new Float32Array(3 * 224 * 224) } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'result', id: 52, result: expect.objectContaining({ packId: 'saved-legacy' }),
    })));
  });

  test('an adapter failure for validated replacement B preserves active A rows and vectors', async () => {
    const first = installedModel('model-A');
    const replacement = installedModel('model-B', true);
    worker.onmessage!({ data: { type: 'load', id: 1, model: first, catalog: catalogPack, index: INDEX } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'loaded', id: 1 })));

    requestAdapter.mockRejectedValueOnce(new Error('Replacement adapter unavailable.'));
    worker.onmessage!({ data: { type: 'load', id: 2, model: replacement, catalog: catalogPack, index: INDEX } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'error', id: 2, code: 'gpu-unavailable', message: 'Replacement adapter unavailable.',
    }));
    expect(doubles.readAsset.mock.calls.filter(([pack]) => pack.manifest.id === 'model-B').map(([, file]) => file.url))
      .toEqual(['vectors.f32', 'rows.json']);
    expect(requestAdapter).toHaveBeenCalledTimes(2);

    worker.onmessage!({ data: { type: 'tensor', id: 3, tensor: new Float32Array(3 * 224 * 224) } });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', id: 3 })));
    const reply = worker.postMessage.mock.calls.map(([reply]) => reply).find(reply => reply.type === 'result' && reply.id === 3);
    expect(reply).toMatchObject({
      type: 'result', result: { packId: 'model-A', catalogId: 'fixture-catalog', candidates: [{ taxonId: 'taxon-0', similarity: 1 },
        { taxonId: 'taxon-1', similarity: 0 }, { taxonId: 'taxon-2', similarity: 0 },
        { taxonId: 'taxon-3', similarity: 0 }, { taxonId: 'taxon-4', similarity: 0 }] },
    });
    expect(doubles.createSession).toHaveBeenCalledTimes(1);
    expect(doubles.release).not.toHaveBeenCalled();
    expect(doubles.inputDispose).toHaveBeenCalledTimes(1);
    expect(doubles.outputDispose).toHaveBeenCalledTimes(1);
  });

  test('loading serializes model requests and drains only the latest queued photo after ready', async () => {
    const first = installedModel('model-A');
    let finishLoading!: (value: typeof session) => void;
    doubles.createSession.mockImplementationOnce(() => new Promise(resolve => { finishLoading = resolve; }));
    worker.onmessage!({ data: { type: 'load', id: 10, model: first, catalog: catalogPack, index: INDEX } });
    await vi.waitFor(() => expect(doubles.createSession).toHaveBeenCalledTimes(1));
    const replacedPhoto = new Blob(['replaced photo']);
    const latestPhoto = new Blob(['latest photo']);
    worker.onmessage!({ data: { type: 'identify', id: 11, photo: replacedPhoto } });
    worker.onmessage!({ data: { type: 'identify', id: 12, photo: latestPhoto } });
    worker.onmessage!({ data: { type: 'load', id: 13, model: first, catalog: catalogPack, index: INDEX } });
    expect(doubles.preparePhoto).not.toHaveBeenCalled();
    expect(doubles.run).not.toHaveBeenCalled();
    expect(worker.postMessage.mock.calls.map(([reply]) => reply)).toEqual([
      { type: 'error', id: 11, code: 'canceled', message: 'Photo replaced.' },
      { type: 'error', id: 13, code: 'model-initialization', message: 'Wait for the identification model to finish loading.' },
    ]);

    finishLoading(session);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', id: 12 })));
    expect(worker.postMessage.mock.calls.map(([reply]) => [reply.type, 'id' in reply ? reply.id : undefined]))
      .toEqual([['error', 11], ['error', 13], ['loaded', 10], ['result', 12]]);
    expect(doubles.preparePhoto).toHaveBeenCalledTimes(1);
    expect(doubles.preparePhoto).toHaveBeenCalledWith(latestPhoto);
    expect(doubles.run).toHaveBeenCalledTimes(1);
    expect(doubles.createSession).toHaveBeenCalledTimes(1);
    expect(doubles.createSession).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.objectContaining({
      executionProviders: [{ name: 'webgpu', device: expect.objectContaining({ features: new Set(['shader-f16']) }) }],
    }));
    expect(doubles.env.wasm).toMatchObject({ numThreads: 1, proxy: false, wasmPaths: {
      mjs: 'https://plants.test/runtime/1.30.0/ort-wasm-simd-threaded.asyncify.mjs',
      wasm: 'https://plants.test/runtime/1.30.0/ort-wasm-simd-threaded.asyncify.wasm',
    } });
  });
});
