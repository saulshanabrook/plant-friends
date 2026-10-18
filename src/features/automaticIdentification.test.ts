import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { AutomaticIdentification, type IdentificationAssets, type IdentificationState } from './automaticIdentification';
import type { InferenceResult, RuntimeInfo } from '../inference/protocol';
import { catalog, INDEX, model } from '../../tests/assets/fixtures';

// Deferred transport doubles and opaque blobs test orchestration only. These
// fabricated metadata records never activate a model or claim numerical/GPU work.
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const assets: IdentificationAssets = { key: 'model-a/catalog-a', index: INDEX,
  model: { manifest: model(), manifestUrl: 'https://plants.test/model/manifest.json', installedAt: '', persistent: false },
  catalog: { manifest: catalog(), manifestUrl: 'https://plants.test/catalog/manifest.json', installedAt: '', persistent: false } };
const photo = { id: 1, blob: new Blob(['opaque photo one']) };
const replacement = { id: 2, blob: new Blob(['opaque photo two']) };
const runtime: RuntimeInfo = { secureContext: true, adapter: {}, features: [], limits: {}, runtimeVersion: 'transport double',
  executionProvider: 'webgpu', initializationMs: 1, modelBytes: 0, packId: 'model-a', catalogId: 'catalog-a',
  backend: 'native-webgpu-asyncify', deviceFeatures: [] };
const result: InferenceResult = { requestId: 1, packId: 'model-a', catalogId: 'catalog-a', inputCount: 1, candidates: [], embedding: [],
  timings: { preprocessingMs: 0, inferenceMs: 0, rankingMs: 0, totalMs: 0 } };
const newerResult = { ...result, requestId: 2 };
const sessions: AutomaticIdentification[] = [];
function harness() {
  const clients: {
    client: { load: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; onDeviceLost?: (message: string) => void };
    loading: ReturnType<typeof deferred<RuntimeInfo>>;
    runs: (ReturnType<typeof deferred<InferenceResult>> & { blob: Blob })[];
  }[] = [];
  const states: IdentificationState[] = [];
  const create = vi.fn(() => {
    const loading = deferred<RuntimeInfo>(), runs: (ReturnType<typeof deferred<InferenceResult>> & { blob: Blob })[] = [];
    const client = { load: vi.fn(() => loading.promise), identify: vi.fn((blob: Blob) => {
      const run = { ...deferred<InferenceResult>(), blob }; runs.push(run); return run.promise;
    }), cancel: vi.fn(), dispose: vi.fn() };
    clients.push({ client, loading, runs });
    return client;
  });
  const session = new AutomaticIdentification(create, state => states.push(state));
  sessions.push(session);
  return { session, clients, states, create };
}
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });

test('a selected photo waits for compatible assets, then runs once without an identify click', async () => {
  const h = harness();
  h.session.setPhoto(photo); await setImmediate();
  expect(h.create).not.toHaveBeenCalled(); expect(h.states.at(-1)?.phase).toBe('waiting');
  h.session.setAssets(assets); await setImmediate();
  expect(h.clients[0].client.load).toHaveBeenCalledExactlyOnceWith(assets.model, assets.catalog, assets.index);
  h.clients[0].loading.resolve(runtime); await setImmediate();
  expect(h.clients[0].client.identify).toHaveBeenCalledExactlyOnceWith(photo.blob);
  h.clients[0].runs[0].resolve(result); await setImmediate();
  expect(h.states.at(-1)).toEqual({ phase: 'complete', result, runtime, error: null });
});

test('duplicate input effects and completed-state rerenders never repeat loading or inference', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) { h.session.setAssets({ ...assets }); h.session.setPhoto({ ...photo }); }
  await setImmediate(); h.clients[0].loading.resolve(runtime); await setImmediate();
  for (let i = 0; i < 5; i++) { h.session.setAssets({ ...assets }); h.session.setPhoto({ ...photo }); }
  h.clients[0].runs[0].resolve(result); await setImmediate();
  for (let i = 0; i < 5; i++) { h.session.setAssets({ ...assets }); h.session.setPhoto({ ...photo }); }
  await setImmediate();
  expect(h.create).toHaveBeenCalledTimes(1); expect(h.clients[0].client.load).toHaveBeenCalledTimes(1);
  expect(h.clients[0].client.identify).toHaveBeenCalledTimes(1);
});

test('replacement during one shared model load identifies only the latest validated photo', async () => {
  const h = harness(); h.session.setAssets(assets); h.session.setPhoto(photo); await setImmediate();
  h.session.setPhoto(null); h.session.setPhoto(replacement); await setImmediate();
  expect(h.create).toHaveBeenCalledTimes(1); expect(h.clients[0].client.load).toHaveBeenCalledTimes(1);
  h.clients[0].loading.resolve(runtime); await setImmediate();
  expect(h.clients[0].client.identify).toHaveBeenCalledExactlyOnceWith(replacement.blob);
  h.clients[0].runs[0].resolve(newerResult); await setImmediate();
  expect(h.states.at(-1)?.result).toBe(newerResult);
});

test('cancel while loading remains cancelled through late load completion and version changes until Retry', async () => {
  const h = harness(); h.session.setAssets(assets); h.session.setPhoto(photo); await setImmediate();
  h.session.cancel(); h.session.setAssets({ ...assets }); h.session.setPhoto({ ...photo });
  h.clients[0].loading.resolve(runtime); await setImmediate();
  expect(h.states.at(-1)?.phase).toBe('cancelled'); expect(h.clients[0].client.identify).not.toHaveBeenCalled();
  h.session.setAssets({ ...assets, key: 'model-b/catalog-a' }); await setImmediate();
  expect(h.create).toHaveBeenCalledTimes(1); expect(h.states.at(-1)?.phase).toBe('cancelled');
  h.session.retry(); await setImmediate();
  expect(h.create).toHaveBeenCalledTimes(2);
  h.clients[1].loading.resolve(runtime); await setImmediate();
  expect(h.clients[1].client.identify).toHaveBeenCalledExactlyOnceWith(photo.blob);
});

test('Retry after cancelling a load reuses its pending promise without duplicate load RPCs', async () => {
  const h = harness(); h.session.setAssets(assets); h.session.setPhoto(photo); await setImmediate();
  h.session.cancel(); h.session.retry(); await setImmediate();
  expect(h.clients[0].client.load).toHaveBeenCalledTimes(1);
  h.clients[0].loading.resolve(runtime); await setImmediate();
  expect(h.clients[0].client.identify).toHaveBeenCalledExactlyOnceWith(photo.blob);
});

test('late old inference success cannot overwrite a retry, and Reset suppresses the retry completion', async () => {
  const h = harness(); h.session.setAssets(assets); h.session.setPhoto(photo); await setImmediate();
  h.clients[0].loading.resolve(runtime); await setImmediate();
  h.session.cancel(); h.session.retry(); await setImmediate();
  expect(h.clients[0].runs).toHaveLength(2);
  h.clients[0].runs[0].resolve(result); await setImmediate();
  expect(h.states.at(-1)?.phase).toBe('identifying'); expect(h.states.at(-1)?.result).toBeNull();
  h.session.setPhoto(null); h.clients[0].runs[1].resolve(newerResult); await setImmediate();
  expect(h.states.at(-1)?.phase).toBe('idle'); expect(h.states.at(-1)?.result).toBeNull();
});

test('late errors from a replaced photo cannot clear the current worker or overwrite its result', async () => {
  const h = harness(); h.session.setAssets(assets); h.session.setPhoto(photo); await setImmediate();
  h.clients[0].loading.resolve(runtime); await setImmediate();
  h.session.setPhoto(replacement); await setImmediate();
  h.clients[0].runs[0].reject(new Error('late stale worker error')); await setImmediate();
  expect(h.clients[0].client.dispose).not.toHaveBeenCalled();
  h.clients[0].runs[1].resolve(newerResult); await setImmediate();
  expect(h.states.at(-1)?.result).toBe(newerResult); expect(h.states.at(-1)?.error).toBeNull();
});

test('a shared load failure is terminal for the latest photo; explicit Retry creates a fresh worker', async () => {
  const h = harness(); h.session.setAssets(assets); h.session.setPhoto(photo); await setImmediate();
  h.session.setPhoto(replacement); await setImmediate();
  h.clients[0].loading.reject(new Error('load failed')); await setImmediate();
  expect(h.states.at(-1)?.error).toBe('load failed'); expect(h.clients[0].client.dispose).toHaveBeenCalledTimes(1);
  h.session.setAssets({ ...assets }); h.session.setPhoto({ ...replacement }); await setImmediate();
  expect(h.create).toHaveBeenCalledTimes(1);
  h.session.retry(); await setImmediate(); expect(h.create).toHaveBeenCalledTimes(2);
  h.clients[1].loading.resolve(runtime); await setImmediate();
  expect(h.clients[1].client.identify).toHaveBeenCalledExactlyOnceWith(replacement.blob);
});

test('ordinary inference failures do not loop; Retry reuses a loaded model and Reload replaces it', async () => {
  const h = harness(); h.session.setAssets(assets); h.session.setPhoto(photo); await setImmediate();
  h.clients[0].loading.resolve(runtime); await setImmediate();
  h.clients[0].runs[0].reject(Object.assign(new Error('inference failed'), { name: 'inference-failed' })); await setImmediate();
  h.session.setAssets({ ...assets }); h.session.setPhoto({ ...photo }); await setImmediate();
  expect(h.clients[0].runs).toHaveLength(1); expect(h.states.at(-1)?.phase).toBe('error');
  h.session.retry(); await setImmediate();
  expect(h.clients[0].client.load).toHaveBeenCalledTimes(1); expect(h.clients[0].runs).toHaveLength(2);
  h.clients[0].runs[1].reject(Object.assign(new Error('still failed'), { name: 'inference-failed' })); await setImmediate();
  h.session.retry(true); await setImmediate();
  expect(h.clients[0].client.dispose).toHaveBeenCalledTimes(1); expect(h.create).toHaveBeenCalledTimes(2);
});

test('sticky worker crashes are discarded so a new photo gets a new client', async () => {
  const h = harness(); h.session.setAssets(assets); h.session.setPhoto(photo); await setImmediate();
  h.clients[0].loading.resolve(runtime); await setImmediate();
  h.clients[0].runs[0].reject(new Error('worker failed')); await setImmediate();
  expect(h.clients[0].client.dispose).toHaveBeenCalledTimes(1); expect(h.states.at(-1)?.runtime).toBeNull();
  h.session.setPhoto(replacement); await setImmediate(); expect(h.create).toHaveBeenCalledTimes(2);
  h.clients[1].loading.resolve(runtime); await setImmediate();
  expect(h.clients[1].client.identify).toHaveBeenCalledExactlyOnceWith(replacement.blob);
});

test('pack-version changes invalidate old loads and results without letting a stale catch clear the new load', async () => {
  const h = harness(); h.session.setAssets(assets); h.session.setPhoto(photo); await setImmediate();
  const newer = { ...assets, key: 'model-b/catalog-b' };
  h.session.setAssets(newer); await setImmediate();
  expect(h.clients[0].client.dispose).toHaveBeenCalledTimes(1);
  h.clients[0].loading.reject(new Error('old model aborted')); await setImmediate();
  expect(h.clients[1].client.dispose).not.toHaveBeenCalled(); expect(h.states.at(-1)?.error).toBeNull();
  h.clients[1].loading.resolve(runtime); await setImmediate();
  expect(h.clients[0].client.identify).not.toHaveBeenCalled(); expect(h.clients[1].runs).toHaveLength(1);
  h.clients[1].runs[0].resolve(newerResult); await setImmediate();
  h.session.setAssets({ ...newer }); await setImmediate();
  expect(h.states.at(-1)?.result).toBe(newerResult); expect(h.clients[1].runs).toHaveLength(1);
});

test('device loss stays terminal without changing photo identity; stale replies cannot resurrect it', async () => {
  const h = harness(); h.session.setAssets(assets); h.session.setPhoto(photo); await setImmediate();
  h.clients[0].loading.resolve(runtime); await setImmediate();
  h.clients[0].client.onDeviceLost?.('GPU lost');
  h.session.setAssets({ ...assets }); h.session.setPhoto({ ...photo });
  h.clients[0].runs[0].resolve(result); await setImmediate();
  expect(h.states.at(-1)?.phase).toBe('error'); expect(h.states.at(-1)?.error).toContain('GPU lost');
  expect(h.states.at(-1)?.result).toBeNull(); expect(h.create).toHaveBeenCalledTimes(1);
  h.session.retry(); await setImmediate(); expect(h.create).toHaveBeenCalledTimes(2);
});

test('effect setup/cleanup/setup before dispatch creates only the live worker, and disposal suppresses late publication', async () => {
  const first = harness(); first.session.setAssets(assets); first.session.setPhoto(photo); first.session.dispose();
  const count = first.states.length;
  const next = harness(); next.session.setAssets(assets); next.session.setPhoto(photo); await setImmediate();
  expect(first.create).not.toHaveBeenCalled(); expect(first.states).toHaveLength(count); expect(next.create).toHaveBeenCalledTimes(1);
  next.session.dispose(); const last = next.states.length;
  next.clients[0].loading.resolve(runtime); await setImmediate();
  expect(next.clients[0].client.identify).not.toHaveBeenCalled(); expect(next.states).toHaveLength(last);
});
