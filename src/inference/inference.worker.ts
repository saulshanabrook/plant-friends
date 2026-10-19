/// <reference lib="webworker" />
import type * as Ort from 'onnxruntime-web/webgpu';
import type { CatalogManifest, ModelManifest } from '../assets/manifest';
import { validateManifest, validateVectors } from '../assets/manifest';
import { readAsset } from '../assets/storage';
import { preparePhoto } from './preprocess';
import { normalize, rank } from './scoring';
import type { InferenceResult, RuntimeInfo, WorkerCommand, WorkerReply } from './protocol';

declare const self: DedicatedWorkerGlobalScope;
let ort: typeof Ort | null = null;
let session: Ort.InferenceSession | null = null;
let manifest: ModelManifest | null = null;
let vectors = new Float32Array();
let rows: string[] = [];
let running = false;
let loading = false;
let pending: Extract<WorkerCommand, { type: 'identify' | 'tensor' }> | null = null;
let info: RuntimeInfo | null = null;
let lost = false;
let sessionKey: string | null = null;
let device: GPUDevice | null = null;

async function load(command: Extract<WorkerCommand, { type: 'load' }>): Promise<RuntimeInfo> {
  const started = performance.now();
  const model = validateManifest(command.model.manifest, command.model.manifestUrl);
  const catalog = validateManifest(command.catalog.manifest, command.catalog.manifestUrl);
  if (model.kind !== 'bioclip2' || catalog.kind !== 'pfaf') throw new Error('Wrong pack types.');
  const key = JSON.stringify([model.id, catalog.id, catalog.sourceSha256, model.model.file.sha256,
    model.vectors.file.sha256, model.catalog.rows.sha256, model.preprocessing.sha256, model.prompts.sha256,
    model.runtime.version, model.runtime.files, model.model.externalData ?? []]);
  if (session && !lost && sessionKey === key && info) return info;
  if (running) throw new Error('Wait for identification to finish before switching models.');
  const jspi = !!model.model.externalData?.length;
  if (jspi && !('Suspending' in WebAssembly))
    throw new Error('This identification pack needs WebAssembly JSPI. Update your browser and retry. PFAF browsing still works.');
  const vectorResponse = await readAsset(command.model, model.vectors.file);
  const loadedVectors = new Float32Array(await vectorResponse.arrayBuffer());
  const loadedRows = await (await readAsset(command.model, model.catalog.rows)).json();
  const validatedRows = validateVectors(loadedVectors, loadedRows, model, catalog as CatalogManifest, command.index);
  if (!self.isSecureContext || !navigator.gpu) throw new Error('WebGPU is unavailable. Use a recent supported browser on localhost or HTTPS. PFAF browsing still works.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance', forceFallbackAdapter: false });
  if (!adapter) throw new Error('No usable GPU adapter was found. PFAF browsing is still available.');
  if (!adapter.features.has('shader-f16')) throw new Error('This GPU does not support the FP16 model. PFAF browsing is still available.');
  const adapterInfo = adapter.info;
  if (adapterInfo.isFallbackAdapter || /swiftshader|software/i.test(`${adapterInfo.description} ${adapterInfo.architecture}`))
    throw new Error('A hardware GPU is required for this model; software emulation is not supported.');
  const runtime = jspi ? await import('onnxruntime-web/jspi') : await import('onnxruntime-web/webgpu');
  runtime.env.wasm.numThreads = 1;
  runtime.env.wasm.proxy = false;
  runtime.env.wasm.wasmPaths = {
    mjs: new URL(model.runtime.files.find(file => file.url.endsWith('.mjs'))!.url, command.model.manifestUrl).href,
    wasm: new URL(model.runtime.files.find(file => file.url.endsWith('.wasm'))!.url, command.model.manifestUrl).href,
  };
  if (!runtime.env.webgpu.adapter) runtime.env.webgpu.adapter = adapter;
  runtime.env.logLevel = command.diagnostics ? 'verbose' : 'warning';
  if (runtime.env.versions.web !== model.runtime.version) throw new Error('The app and downloaded runtime versions differ. Refresh and reinstall a compatible pack.');
  const bytes = await (await readAsset(command.model, model.model.file)).arrayBuffer();
  // JSPI reads initializer ranges from Blob backing. Never materialize the
  // external weights as a model-sized JavaScript ArrayBuffer.
  const externalData: { path: string; data: Blob }[] = [];
  for (const entry of model.model.externalData ?? []) {
    const data = await (await readAsset(command.model, entry.file)).blob();
    if (data.size !== entry.file.bytes) throw new Error('The saved encoder weights have an incorrect size. Reinstall the identification pack.');
    externalData.push({ path: entry.path, data });
  }
  if (session) await session.release();
  session = null; manifest = null; info = null; sessionKey = null;
  const previousDevice = device;
  device = null;
  previousDevice?.destroy();
  const nextDevice = await adapter.requestDevice({ requiredFeatures: ['shader-f16'], requiredLimits: {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
  } });
  try {
    session = await runtime.InferenceSession.create(bytes, {
      executionProviders: [{ name: 'webgpu', device: nextDevice }], enableProfiling: false,
      logSeverityLevel: command.diagnostics ? 0 : 2, logVerbosityLevel: command.diagnostics ? 1 : 0,
      ...(jspi ? { externalData } : {}),
    });
  } catch (error) { nextDevice.destroy(); throw error; }
  device = nextDevice;
  if (!session.inputNames.includes(model.model.inputName) || !session.outputNames.includes(model.model.outputName)) {
    await session.release(); session = null; device = null; nextDevice.destroy();
    throw new Error('The exported model has unexpected input or output names.');
  }
  rows = validatedRows;
  ort = runtime;
  vectors = loadedVectors;
  manifest = model;
  sessionKey = key;
  lost = false;
  void nextDevice.lost.then(reason => {
    if (device !== nextDevice) return;
    lost = true;
    self.postMessage({ type: 'device-lost', message: `The GPU connection was lost (${reason.reason}). Reload identification to try again.` } satisfies WorkerReply);
  });
  info = {
    secureContext: self.isSecureContext,
    adapter: { vendor: adapterInfo.vendor, architecture: adapterInfo.architecture, device: adapterInfo.device, description: adapterInfo.description, isFallbackAdapter: adapterInfo.isFallbackAdapter },
    features: [...adapter.features],
    limits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
    runtimeVersion: model.runtime.version, executionProvider: 'webgpu', initializationMs: performance.now() - started,
    modelBytes: model.model.file.bytes + (model.model.externalData ?? []).reduce((total, entry) => total + entry.file.bytes, 0),
    packId: model.id, catalogId: model.catalog.id,
    backend: jspi ? 'native-webgpu-jspi' : 'native-webgpu-asyncify', deviceFeatures: [...nextDevice.features],
  };
  return info;
}

async function drain(): Promise<void> {
  if (running || loading) return;
  running = true;
  while (pending) {
    const command = pending;
    pending = null;
    try {
      if (!session || !manifest || !ort) throw new Error('Load the downloaded identification pack first.');
      if (lost) throw new Error('The GPU connection was lost. Reload identification to try again.');
      const started = performance.now();
      const data = command.type === 'tensor' ? command.tensor : await preparePhoto(command.photo);
      if (data.length !== 3 * 224 * 224 || !data.every(Number.isFinite)) throw new Error('Invalid image tensor.');
      const prepared = performance.now();
      const input = new ort.Tensor('float32', data, [1, 3, 224, 224]);
      // Native ORT has no JSEP timestamp callback. A separate diagnostic run
      // counts actual WebGPU dispatch calls; ordinary warm runs have no hooks.
      const profile: InferenceResult['gpuProfile'] = command.profile
        ? { method: 'WebGPU dispatch calls', dispatchCount: 0, dispatchMethods: {} } : undefined;
      const prototype = GPUComputePassEncoder.prototype;
      const dispatch = prototype.dispatchWorkgroups;
      const indirect = prototype.dispatchWorkgroupsIndirect;
      if (profile) {
        prototype.dispatchWorkgroups = function (...args: Parameters<GPUComputePassEncoder['dispatchWorkgroups']>) {
          profile.dispatchCount++; profile.dispatchMethods.dispatchWorkgroups = (profile.dispatchMethods.dispatchWorkgroups ?? 0) + 1;
          return Reflect.apply(dispatch, this, args);
        };
        prototype.dispatchWorkgroupsIndirect = function (...args: Parameters<GPUComputePassEncoder['dispatchWorkgroupsIndirect']>) {
          profile.dispatchCount++; profile.dispatchMethods.dispatchWorkgroupsIndirect = (profile.dispatchMethods.dispatchWorkgroupsIndirect ?? 0) + 1;
          return Reflect.apply(indirect, this, args);
        };
      }
      let outputs: Ort.InferenceSession.ReturnType | null = null;
      try {
        outputs = await session.run({ [manifest.model.inputName]: input });
        const inferred = performance.now();
        const embedding = normalize(new Float32Array(outputs[manifest.model.outputName].data as Float32Array));
        const candidates = rank(embedding, vectors, rows);
        const finished = performance.now();
        const result: InferenceResult = {
          requestId: command.id, packId: manifest.id, catalogId: manifest.catalog.id, inputCount: 1,
          candidates, embedding: Array.from(embedding),
          timings: { preprocessingMs: prepared - started, inferenceMs: inferred - prepared, rankingMs: finished - inferred, totalMs: finished - started },
        };
        if (command.profile) {
          await device!.queue.onSubmittedWorkDone();
          result.gpuProfile = profile;
        }
        self.postMessage({ type: 'result', id: command.id, result } satisfies WorkerReply);
      } finally {
        if (profile) { prototype.dispatchWorkgroups = dispatch; prototype.dispatchWorkgroupsIndirect = indirect; }
        input.dispose();
        if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isImageError = /photo|JPEG|PNG|WebP|megapixel|image tensor|panorama/.test(message);
      self.postMessage({ type: 'error', id: command.id, code: lost ? 'device-lost' : isImageError ? 'invalid-image' : 'inference-failed',
        message: isImageError || lost ? message : 'Identification failed. Reload the model or try a different photo.', detail: message } satisfies WorkerReply);
    }
  }
  running = false;
}

self.onmessage = event => {
  const command = event.data as WorkerCommand;
  if (command.type === 'load') {
    if (loading) {
      self.postMessage({ type: 'error', id: command.id, code: 'model-initialization', message: 'Wait for the identification model to finish loading.' } satisfies WorkerReply);
      return;
    }
    loading = true;
    void load(command).then(result => self.postMessage({ type: 'loaded', id: command.id, result } satisfies WorkerReply))
      .catch(error => self.postMessage({ type: 'error', id: command.id, code: /GPU|FP16|adapter/.test(String(error)) ? 'gpu-unavailable' : 'model-initialization',
        message: error instanceof Error ? error.message : String(error) } satisfies WorkerReply))
      .finally(() => { loading = false; void drain(); });
  } else if (command.type === 'cancel') {
    if (pending) self.postMessage({ type: 'error', id: pending.id, code: 'canceled', message: 'Photo replaced.' } satisfies WorkerReply);
    pending = null;
  } else {
    if (pending) self.postMessage({ type: 'error', id: pending.id, code: 'canceled', message: 'Photo replaced.' } satisfies WorkerReply);
    pending = command;
    void drain();
  }
};
