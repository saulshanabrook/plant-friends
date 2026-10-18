import { expect, test } from 'vitest';
import { catalog, model } from '../../tests/assets/fixtures';
import plan from '../assets/download-plan.json';
import { DownloadEstimator, downloadObservation, type DownloadEstimateInput, type DownloadObservation } from './useDownloadEstimate';

const KiB = 1_024;
function input(): DownloadEstimateInput {
  return {
    packs: {
      pfaf: { available: null, installed: null, downloading: false, progress: null },
      bioclip2: { available: null, installed: null, downloading: false, progress: null },
    },
    phase: 'checking',
    photos: { phase: 'waiting', progress: { received: 0, total: 0, completed: 0, totalFiles: 0 }, metadataReady: false, transfer: null },
  };
}
function observation(patch: Partial<DownloadObservation> = {}): DownloadObservation {
  return { stage: 'bioclip2:fixture', source: 'weights.onnx', counter: 0, active: true, measurable: true,
    remainingBytes: 2_000 * KiB, totalBytes: 3_000 * KiB, ...patch };
}

test('the initial remaining payload includes future catalog, model, photo index and all deduplicated images', () => {
  const total = plan.catalog.bytes + plan.model.bytes + plan.photos.imageBytes + plan.photos.metadataBytes;
  expect(downloadObservation(input())).toEqual(observation({ stage: null, source: null, active: false, measurable: false, remainingBytes: total, totalBytes: total }));
});

test('validated manifests override pinned fallback payloads and installed receipts remove saved stages', () => {
  const state = input(), pfaf = catalog(), bioclip2 = model();
  pfaf.files = [{ ...pfaf.files[0], bytes: 500 }];
  bioclip2.files = [{ ...bioclip2.files[0], bytes: 1_000 }];
  state.packs.pfaf.installed = { manifest: pfaf };
  state.packs.bioclip2.available = { manifest: bioclip2 };
  state.packs.bioclip2.downloading = true;
  state.packs.bioclip2.progress = { received: 400, total: 1_000, file: 'weights.onnx', phase: 'downloading' };
  state.phase = 'downloading';
  const sample = downloadObservation(state);
  expect(sample).toMatchObject({ stage: `bioclip2:${bioclip2.id}`, source: 'weights.onnx', counter: 400, active: true, measurable: true,
    totalBytes: 1_500 + plan.photos.imageBytes + plan.photos.metadataBytes,
    remainingBytes: 600 + plan.photos.imageBytes + plan.photos.metadataBytes });
  state.packs.bioclip2.installed = { manifest: bioclip2 };
  state.packs.bioclip2.downloading = false;
  state.phase = 'idle';
  state.photos = { phase: 'ready', metadataReady: true, transfer: null, progress: { received: 900, total: 900, completed: 2, totalFiles: 2 } };
  expect(downloadObservation(state)).toMatchObject({ remainingBytes: 0, totalBytes: 1_500 + 900 + plan.photos.metadataBytes, active: false });
});

test('photo metadata counts as network; an image cache inventory only reduces remaining work', () => {
  const state = input();
  state.packs.pfaf.installed = { manifest: catalog() };
  state.packs.bioclip2.installed = { manifest: model() };
  state.photos.phase = 'checking'; state.photos.transfer = { id: 3, received: 50_000 };
  expect(downloadObservation(state)).toMatchObject({ stage: 'photos:3:metadata', counter: 50_000, measurable: false,
    remainingBytes: plan.photos.imageBytes + plan.photos.metadataBytes - 50_000 });
  state.photos.metadataReady = true; state.photos.phase = 'downloading';
  state.photos.progress = { received: 150_000_000, total: 165_000_000, completed: 11_000, totalFiles: 12_000 };
  expect(downloadObservation(state)).toMatchObject({ stage: 'photos:3:images', counter: 50_000, remainingBytes: 15_000_000 });
  state.photos.transfer = { id: 3, received: 60_000 };
  expect(downloadObservation(state).counter).toBe(60_000);
});

test('decoded compressed catalog bytes reduce remaining work without projecting a binary transfer rate', () => {
  const state = input(), estimator = new DownloadEstimator();
  state.phase = 'downloading'; state.packs.pfaf.downloading = true;
  for (const [at, received] of [[0, 0], [2_000, 10_000_000], [5_000, 20_000_000]]) {
    state.packs.pfaf.progress = { received, total: plan.catalog.bytes, file: 'details.json', phase: 'downloading' };
    const sample = downloadObservation(state);
    expect(sample.measurable).toBe(false);
    expect(estimator.observe(sample, at, true, true)).toMatchObject({ seconds: null, label: 'Estimating…' });
    expect(sample.remainingBytes).toBe(sample.totalBytes - received);
  }
});

test('decoded gzip photo metadata never carries its apparent speed into the WebP stage', () => {
  const state = input(), estimator = new DownloadEstimator();
  state.packs.pfaf.installed = { manifest: catalog() }; state.packs.bioclip2.installed = { manifest: model() };
  state.photos.phase = 'checking';
  // fetch() exposes decoded JSON body bytes, which can greatly exceed gzip wire bytes.
  for (const [at, received] of [[0, 0], [2_000, 4_000_000], [5_000, plan.photos.metadataBytes]]) {
    state.photos.transfer = { id: 8, received };
    expect(estimator.observe(downloadObservation(state), at, true, true).seconds).toBeNull();
  }
  state.photos.phase = 'downloading'; state.photos.metadataReady = true;
  state.photos.progress = { received: 0, total: 10_000 * KiB, completed: 0, totalFiles: 10 };
  expect(estimator.observe(downloadObservation(state), 6_000, true, true)).toMatchObject({ seconds: null, label: 'Estimating…' });
  state.photos.transfer = { id: 8, received: plan.photos.metadataBytes + 200 * KiB };
  expect(estimator.observe(downloadObservation(state), 8_000, true, true).seconds).toBeNull();
  state.photos.transfer.received += 300 * KiB;
  expect(estimator.observe(downloadObservation(state), 11_000, true, true)).toMatchObject({ seconds: 120, label: 'About 2 minutes remaining' });
});

test('warmup needs five seconds, two network increments and enough transferred bytes', () => {
  const estimator = new DownloadEstimator();
  expect(estimator.observe(observation(), 0, true, true).label).toBe('Estimating…');
  expect(estimator.observe(observation({ counter: 40 * KiB }), 2_000, true, true).seconds).toBeNull();
  expect(estimator.observe(observation({ counter: 100 * KiB }), 4_999, true, true).seconds).toBeNull();
  expect(estimator.observe(observation({ counter: 100 * KiB }), 5_000, true, true)).toMatchObject({ seconds: 120, label: 'About 2 minutes remaining' });
});

test('cache-prefix checking never becomes an artificial transfer rate, including resumed network', () => {
  const estimator = new DownloadEstimator();
  estimator.observe(observation({ measurable: false }), 0, true, true);
  estimator.observe(observation({ counter: 500_000_000, measurable: false }), 1_000, true, true);
  estimator.observe(observation({ counter: 500_000_000 + 64 * KiB }), 2_000, true, true);
  estimator.observe(observation({ counter: 500_000_000 + 128 * KiB }), 3_000, true, true);
  const estimate = estimator.observe(observation({ counter: 500_000_000 + 192 * KiB }), 5_000, true, true);
  expect(estimate).toMatchObject({ seconds: 120, label: 'About 2 minutes remaining' });
});

test.each(['stage', 'retry', 'offline', 'hidden', 'inactive', 'stall'] as const)('%s discards the old rate and requires fresh warmup', cause => {
  const estimator = new DownloadEstimator();
  estimator.observe(observation(), 0, true, true);
  estimator.observe(observation({ counter: 50 * KiB }), 2_000, true, true);
  const warm = observation({ counter: 100 * KiB });
  expect(estimator.observe(warm, 5_000, true, true).seconds).toBe(120);
  const next = { ...warm };
  if (cause === 'stage') next.stage = 'photos:4';
  if (cause === 'retry') next.counter = 0;
  if (cause === 'inactive') next.active = false;
  const value = estimator.observe(next, cause === 'stall' ? 15_000 : 6_000, cause !== 'offline', cause !== 'hidden');
  expect(value.seconds).toBeNull();
  if (['offline', 'hidden', 'inactive'].includes(cause)) expect(value.label).toBeNull();
  expect(estimator.observe(next, cause === 'stall' ? 16_000 : 7_000, true, true).seconds).toBeNull();
});

test('file boundaries rebase the cumulative counter without counting the new file prefix', () => {
  const estimator = new DownloadEstimator();
  estimator.observe(observation(), 0, true, true);
  estimator.observe(observation({ counter: 50 * KiB }), 2_000, true, true);
  estimator.observe(observation({ counter: 100 * KiB }), 5_000, true, true);
  const next = observation({ source: 'vectors.f32', counter: 500_000_000 });
  expect(estimator.observe(next, 6_000, true, true).seconds).toBe(120);
  expect(estimator.observe({ ...next, counter: next.counter + 40 * KiB }, 7_000, true, true).seconds).toBe(120);
});

test.each([[100 * KiB, 10, 'About 10 seconds remaining'], [1_100 * KiB, 60, 'About 1 minute remaining'], [13_000 * KiB, 900, 'About 15 minutes remaining']] as const)('rounds a remaining payload of %i bytes coarsely', (remainingBytes, seconds, label) => {
  const estimator = new DownloadEstimator();
  estimator.observe(observation({ remainingBytes }), 0, true, true);
  estimator.observe(observation({ remainingBytes, counter: 50 * KiB }), 2_000, true, true);
  expect(estimator.observe(observation({ remainingBytes, counter: 100 * KiB }), 5_000, true, true)).toMatchObject({ seconds, label });
  expect(estimator.observe(observation({ remainingBytes: 0, counter: 100 * KiB }), 6_000, true, true)).toMatchObject({ seconds: null, label: null });
});
