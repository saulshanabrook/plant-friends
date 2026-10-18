/** Bounded native ORT WebGPU experiment; no app/runtime/export/tolerance edits. */
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

const origin = process.env.PLANT_PROBE_ORIGIN ?? 'http://127.0.0.1:4174';
const overrideUrl = process.env.PLANT_PROBE_ENCODER_URL;
const overrideHash = process.env.PLANT_PROBE_ENCODER_SHA256;
const overrideSize = process.env.PLANT_PROBE_ENCODER_BYTES;
const overrideRequested = [overrideUrl, overrideHash, overrideSize].some(value => value !== undefined);
if (overrideRequested && (!overrideUrl || !/^[a-f0-9]{64}$/.test(overrideHash ?? '') || !Number.isSafeInteger(Number(overrideSize)) || Number(overrideSize) <= 0))
  throw new Error('An explicit diagnostic encoder override requires URL, SHA256 and BYTES together.');
if (overrideUrl && new URL(overrideUrl, origin).origin !== new URL(origin).origin)
  throw new Error('The diagnostic encoder override must be served from the same local origin.');
const label = process.env.PLANT_PROBE_LABEL ?? (overrideRequested ? 'encoder-override' : '');
if (label && !/^[a-z0-9-]+$/.test(label)) throw new Error('Use a lowercase alphanumeric/hyphen report label.');
if (overrideRequested && !label) throw new Error('Encoder overrides require a separate report label.');
const output = resolve(`tests/assets/native-webgpu-probe${label ? '.' + label : ''}.json`);
const rawLogPath = resolve(`tests/assets/native-webgpu-probe${label ? '.' + label : ''}.log`);
const dist = resolve('node_modules/onnxruntime-web/dist');
const runtimeFiles = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
const logs = [];
const report = {
  measuredAt: new Date().toISOString(), status: 'running', stage: 'metadata', origin,
  scope: 'Main-thread diagnostic only; exact existing full encoder, nine saved tensors and 12 catalog vectors. No fallback implementation or tolerance changes.',
  runtimeIdentity: { package: 'onnxruntime-web', entry: '/webgpu', backend: 'native WebGPU / Asyncify; not JSEP', files: [] },
  events: [], samples: [], requests: [],
};
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
const rawLog = createWriteStream(rawLogPath);
let context, profile, timer;
try {
  for (const name of runtimeFiles) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(join(dist, name))) { hash.update(chunk); bytes += chunk.length; }
    report.runtimeIdentity.files.push({ name, bytes, sha256: hash.digest('hex'), url: `${origin}/node_modules/onnxruntime-web/dist/${name}` });
  }
  report.runtimeIdentity.packageVersion = JSON.parse(await readFile(resolve('node_modules/onnxruntime-web/package.json'), 'utf8')).version;
  if (report.runtimeIdentity.packageVersion !== '1.30.0') throw new Error('This probe is pinned to the installed ORT 1.30.0 package.');
  const pointer = await (await fetch(`${origin}/model.json`, { cache: 'no-store' })).json();
  const manifestUrl = new URL(pointer.url, `${origin}/model.json`).href;
  const model = await (await fetch(manifestUrl, { cache: 'no-store' })).json();
  const referenceUrl = `${origin}/fixtures/reference/manifest.json`;
  const reference = await (await fetch(referenceUrl, { cache: 'no-store' })).json();
  if (!reference.exportChecked || reference.packId !== model.id || reference.samples.length !== 9 || model.catalog.taxonCount !== 12)
    throw new Error('The active pack must match the checked nine-tensor / 12-vector reference set.');
  report.modelIdentity = { packId: model.id, model: model.model, catalog: model.catalog, vectors: model.vectors, preprocessing: model.preprocessing, promptHash: model.prompts.sha256 };
  const encoder = overrideRequested
    ? { url: new URL(overrideUrl, origin).href, sha256: overrideHash, bytes: Number(overrideSize), diagnosticOverride: true }
    : { ...model.model.file, url: new URL(model.model.file.url, manifestUrl).href, diagnosticOverride: false };
  report.encoderIdentity = encoder;
  report.referenceIdentity = { url: referenceUrl, packId: reference.packId, exportChecked: reference.exportChecked, samples: reference.samples };
  report.tolerances = await (await fetch(`${origin}/fixtures/numerical/tolerances.json`, { cache: 'no-store' })).json();
  const vectorsBytes = await (await fetch(new URL(model.vectors.file.url, manifestUrl), { cache: 'no-store' })).arrayBuffer();
  if (createHash('sha256').update(new Uint8Array(vectorsBytes)).digest('hex') !== model.vectors.file.sha256)
    throw new Error('The actual text vector file differs from the pack descriptor.');
  const vectors = new Float32Array(vectorsBytes);
  const rows = await (await fetch(new URL(model.catalog.rows.url, manifestUrl), { cache: 'no-store' })).json();
  const expected = new Map();
  for (const sample of reference.samples) {
    const bytes = await (await fetch(new URL(sample.embeddingUrl, referenceUrl), { cache: 'no-store' })).arrayBuffer();
    if (createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !== sample.embeddingFile.sha256)
      throw new Error(`Reference embedding integrity failed: ${sample.id}`);
    expected.set(sample.id, new Float32Array(bytes));
  }
  await mkdir(resolve('.cache'), { recursive: true });
  profile = await mkdtemp(resolve('.cache/native-webgpu-probe-'));
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
  report.browser = context.browser()?.version();
  timer = setTimeout(() => { report.timedOut = true; void context.close(); }, 180_000);
  context.on('console', message => {
    const entry = { type: message.type(), text: message.text() };
    rawLog.write(JSON.stringify(entry) + '\n');
    if (logs.length < 20_000) logs.push(entry);
  });
  context.on('weberror', event => {
    const entry = { type: 'pageerror', text: event.error().stack ?? event.error().message };
    rawLog.write(JSON.stringify(entry) + '\n'); logs.push(entry);
  });
  context.on('request', request => {
    report.requests.push({ url: request.url(), method: request.method(), bodyBytes: request.postDataBuffer()?.length ?? 0 });
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.route('**/__native-webgpu-probe__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native WebGPU diagnostic</title>' }));
  await page.exposeFunction('nativeProbeStage', async event => {
    report.stage = event.stage; report.events.push(event); Object.assign(report, event.record ?? {});
    console.log(JSON.stringify(event)); await save();
  });
  await page.exposeFunction('nativeProbeSample', async sample => {
    const actual = normalized(sample.rawEmbedding);
    const metrics = compare(expected.get(sample.id), actual, vectors);
    const actualCandidates = rank(actual, vectors, rows);
    const expectedCandidates = rank(normalized(expected.get(sample.id)), vectors, rows);
    const thresholds = report.tolerances;
    const pass = metrics.cosine >= thresholds.fp16CosineMin && metrics.maxError <= thresholds.fp16MaxEmbeddingError && metrics.maxScoreError <= thresholds.fp16MaxScoreError;
    const result = { ...sample, normalizedEmbedding: Array.from(actual), metrics, passesExistingTensorThresholds: pass, actualCandidates, expectedCandidates,
      rankingChanged: actualCandidates.some((candidate, index) => candidate.taxonId !== expectedCandidates[index].taxonId) };
    report.samples.push(result);
    console.log(JSON.stringify({ event: 'sample', id: sample.id, metrics, runMs: sample.runMs, gpuDispatches: sample.gpuDispatches, passesExistingTensorThresholds: pass }));
    await save();
  });
  await page.goto(`${origin}/__native-webgpu-probe__`);
  const completion = await page.evaluate(async ({ origin, encoder, model, referenceUrl, reference, runtimeFiles }) => {
    await window.nativeProbeStage({ stage: 'import-native-runtime' });
    const ort = await import(`${origin}/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs`);
    if (ort.env.versions.web !== '1.30.0') throw new Error(`Unexpected runtime version: ${ort.env.versions.web}`);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { mjs: runtimeFiles[1].url, wasm: runtimeFiles[2].url };
    ort.env.logLevel = 'verbose';
    if (!navigator.gpu || !isSecureContext) throw new Error('Secure-context WebGPU is unavailable.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance', forceFallbackAdapter: false });
    if (!adapter || adapter.info.isFallbackAdapter || /swiftshader|software/i.test(adapter.info.description)) throw new Error('A hardware GPU adapter is required.');
    if (!adapter.features.has('shader-f16')) throw new Error('The hardware adapter lacks shader-f16.');
    const requiredFeatures = ['shader-f16'];
    if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures, requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    } });
    const counters = { dispatches: 0, pipelineCreations: 0 };
    for (const name of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']) {
      const original = GPUComputePassEncoder.prototype[name];
      GPUComputePassEncoder.prototype[name] = function (...args) { counters.dispatches++; return Reflect.apply(original, this, args); };
    }
    for (const name of ['createComputePipeline', 'createComputePipelineAsync']) {
      const original = GPUDevice.prototype[name];
      GPUDevice.prototype[name] = function (...args) { counters.pipelineCreations++; return Reflect.apply(original, this, args); };
    }
    const gpuErrors = [];
    device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
    void device.lost.then(info => gpuErrors.push(`Device lost: ${info.reason} ${info.message}`));
    ort.env.webgpu.adapter = adapter;
    await window.nativeProbeStage({ stage: 'hardware-ready', record: {
      environment: { userAgent: navigator.userAgent, secureContext: isSecureContext, runtimeVersions: ort.env.versions },
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
        description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter, features: [...adapter.features],
        limits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize } },
      sessionOptions: { executionProviders: [{ name: 'webgpu', customHardwareDevice: true }], enableProfiling: false, logSeverityLevel: 0, logVerbosityLevel: 1 },
    } });
    const downloadStarted = performance.now();
    const response = await fetch(encoder.url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Encoder fetch failed: HTTP ${response.status}`);
    let bytes = await response.arrayBuffer();
    if (bytes.byteLength !== encoder.bytes) throw new Error('Encoder byte size differs from its explicit descriptor.');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== encoder.sha256) throw new Error('The actual encoder hash differs from its explicit descriptor.');
    await window.nativeProbeStage({ stage: 'create-native-session', record: { encoderDownloadedAndVerified: { bytes: bytes.byteLength, sha256: digest, elapsedMs: performance.now() - downloadStarted } } });
    const created = performance.now();
    const session = await ort.InferenceSession.create(bytes, { executionProviders: [{ name: 'webgpu', device }], enableProfiling: false, logSeverityLevel: 0, logVerbosityLevel: 1 });
    bytes = null;
    await window.nativeProbeStage({ stage: 'native-session-ready', record: { sessionCreationMs: performance.now() - created, inputNames: session.inputNames, outputNames: session.outputNames } });
    try {
      for (const sample of reference.samples) {
        const response = await fetch(new URL(sample.inputUrl, referenceUrl), { cache: 'no-store' });
        if (!response.ok) throw new Error(`Tensor fetch failed: ${sample.id}`);
        const inputBytes = await response.arrayBuffer();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', inputBytes)), value => value.toString(16).padStart(2, '0')).join('');
        if (inputBytes.byteLength !== sample.inputFile.bytes || digest !== sample.inputFile.sha256) throw new Error(`Saved tensor integrity failed: ${sample.id}`);
        const input = new ort.Tensor('float32', new Float32Array(inputBytes), [1, 3, 224, 224]);
        const dispatchBefore = counters.dispatches;
        const pipelinesBefore = counters.pipelineCreations;
        const started = performance.now();
        let outputs;
        try {
          outputs = await session.run({ [model.model.inputName]: input });
          const output = outputs[model.model.outputName];
          const rawEmbedding = Array.from(output.data);
          await window.nativeProbeSample({ id: sample.id, inputSha256: digest, outputType: output.type, outputDims: output.dims,
            rawEmbedding, runMs: performance.now() - started, gpuDispatches: counters.dispatches - dispatchBefore,
            computePipelinesCreated: counters.pipelineCreations - pipelinesBefore });
        } finally {
          input.dispose();
          if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
        }
      }
      return { gpuErrors, totalGpuDispatches: counters.dispatches, totalComputePipelinesCreated: counters.pipelineCreations };
    } finally { await session.release(); device.destroy(); }
  }, { origin, encoder, model, referenceUrl, reference, runtimeFiles: report.runtimeIdentity.files });
  report.completion = completion;
  const warm = report.samples.slice(1).map(sample => sample.runMs).sort((left, right) => left - right);
  report.summary = {
    samples: report.samples.length,
    minimumCosine: Math.min(...report.samples.map(sample => sample.metrics.cosine)),
    maximumNormalizedEmbeddingError: Math.max(...report.samples.map(sample => sample.metrics.maxError)),
    maximumScoreErrorAcross12Vectors: Math.max(...report.samples.map(sample => sample.metrics.maxScoreError)),
    maximumNormError: Math.max(...report.samples.map(sample => sample.metrics.normError)),
    thresholdFailures: report.samples.filter(sample => !sample.passesExistingTensorThresholds).map(sample => sample.id),
    rankingChanges: report.samples.filter(sample => sample.rankingChanged).map(sample => sample.id),
    firstRunMs: report.samples[0]?.runMs,
    warmSampleCount: warm.length,
    warmMedianMs: (warm[3] + warm[4]) / 2,
    warmMinimumMs: warm[0], warmMaximumMs: warm.at(-1),
    timingScope: 'Main-thread diagnostic session.run/output readback on the nine saved tensors; first sample includes cold kernel compilation. Not a production benchmark.',
  };
  report.status = report.summary.thresholdFailures.length ? 'measured-threshold-failures' : 'passed-existing-tensor-thresholds';
} catch (error) {
  report.status = 'failed'; report.failure = error.stack ?? String(error);
} finally {
  clearTimeout(timer);
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  report.logs = { rawFile: rawLogPath, retainedCount: logs.length,
    placement: logs.filter(entry => /VerifyEachNode|assigned|placed on|node placement|ExecutionProvider|CPU fallback/i.test(entry.text)),
    warningsAndErrors: logs.filter(entry => ['warning', 'pageerror'].includes(entry.type) || /\[[WEF]:onnxruntime/.test(entry.text)),
    consoleTransportCaveat: 'ORT sends informational/verbose messages and shader source through console.error too; actual ORT warnings/errors are selected by their severity markers. Full raw output is retained.',
    caveat: 'Constant-folding CPU-kernel warnings alone do not prove runtime CPU fallback. GPU dispatch instrumentation plus provider placement logs are retained.' };
  report.shaderEvidence = [];
  let shader;
  for (const { text } of logs) {
    if (/=== WebGPU Shader code \[(Gemm|MatMul),/.test(text) && / Start ===/.test(text)) shader = { label: text, accumulationLines: [] };
    else if (shader && /=== WebGPU Shader code .* End ===/.test(text)) { report.shaderEvidence.push(shader); shader = undefined; }
    else if (shader && /var.*(value|sum|acc)|array<.*f16|array<.*f32|alias (a|b|output)_element_t/.test(text)) shader.accumulationLines.push(text);
  }
  report.finishedAt = new Date().toISOString();
  await save();
  rawLog.end(); await once(rawLog, 'finish');
  console.log(JSON.stringify({ status: report.status, stage: report.stage, summary: report.summary, failure: report.failure, output, rawLogPath }));
}
if (report.status === 'failed') process.exitCode = 1;

function normalized(values) {
  if (values.length !== 768 || !Array.from(values).every(Number.isFinite)) throw new Error('Expected a finite 768-component embedding.');
  const norm = Math.sqrt(Array.from(values).reduce((sum, value) => sum + value * value, 0));
  if (norm < 1e-12) throw new Error('Expected a nonzero embedding.');
  return Float32Array.from(values, value => value / norm);
}
function compare(reference, actual, vectors) {
  const norm = Math.sqrt(Array.from(reference).reduce((sum, value) => sum + value * value, 0));
  let cosine = 0, maxError = 0, maxScoreError = 0;
  for (let column = 0; column < 768; column++) {
    const expected = reference[column] / norm;
    cosine += expected * actual[column];
    maxError = Math.max(maxError, Math.abs(expected - actual[column]));
  }
  for (let row = 0; row < vectors.length / 768; row++) {
    let delta = 0;
    for (let column = 0; column < 768; column++) delta += (reference[column] / norm - actual[column]) * vectors[row * 768 + column];
    maxScoreError = Math.max(maxScoreError, Math.abs(delta));
  }
  return { cosine, maxError, maxScoreError, normError: Math.abs(Math.sqrt(Array.from(actual).reduce((sum, value) => sum + value * value, 0)) - 1) };
}
function rank(embedding, vectors, rows) {
  const image = normalized(embedding);
  return rows.map((taxonId, row) => {
    let similarity = 0;
    for (let column = 0; column < 768; column++) similarity += image[column] * vectors[row * 768 + column];
    return { taxonId, similarity };
  }).sort((left, right) => right.similarity - left.similarity || (left.taxonId < right.taxonId ? -1 : left.taxonId > right.taxonId ? 1 : 0)).slice(0, 5);
}
