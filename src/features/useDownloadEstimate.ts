import { useEffect, useRef, useState } from 'react';
import type { PackManifest } from '../assets/manifest';
import type { DownloadProgress } from '../assets/storage';
import type { PlantPhotosState } from './usePlantPhotos';
import plan from '../assets/download-plan.json';

interface EstimatePack {
  available: { manifest: PackManifest } | null;
  installed: { manifest: PackManifest } | null;
  downloading: boolean;
  progress: DownloadProgress | null;
}
export interface DownloadEstimateInput {
  packs: { pfaf: EstimatePack; bioclip2: EstimatePack };
  phase: string;
  photos: Pick<PlantPhotosState, 'phase' | 'progress' | 'metadataReady' | 'transfer'>;
}
export interface DownloadEstimate { seconds: number | null; label: string | null; remainingBytes: number; totalBytes: number }
export interface DownloadObservation {
  stage: string | null; source: string | null; counter: number; active: boolean; measurable: boolean;
  remainingBytes: number; totalBytes: number;
}

/** Sum all future stages too. Uninspected future caches conservatively retain
 * their pinned payload until validated receipts/inventory establish saved bytes. */
export function downloadObservation(input: DownloadEstimateInput): DownloadObservation {
  const photoBytes = input.photos.metadataReady ? input.photos.progress.total : plan.photos.imageBytes;
  let totalBytes = photoBytes + plan.photos.metadataBytes;
  const metadataInFlight = !input.photos.metadataReady && input.photos.phase === 'checking' ? input.photos.transfer?.received ?? 0 : 0;
  let remainingBytes = Math.max(0, photoBytes - input.photos.progress.received) +
    (input.photos.metadataReady ? 0 : Math.max(0, plan.photos.metadataBytes - metadataInFlight));
  let stage: string | null = null, source: string | null = null, counter = 0, active = false, measurable = false;
  for (const kind of ['pfaf', 'bioclip2'] as const) {
    const pack = input.packs[kind];
    const manifest = pack.installed?.manifest ?? pack.available?.manifest;
    const bytes = manifest ? manifest.files.reduce((sum, file) => sum + file.bytes, 0) : kind === 'pfaf' ? plan.catalog.bytes : plan.model.bytes;
    totalBytes += bytes;
    if (!pack.installed) remainingBytes += Math.max(0, bytes - Math.min(bytes, pack.progress?.received ?? 0));
    if (input.phase === 'downloading' && pack.downloading) {
      stage = `${kind}:${manifest?.id ?? 'pending'}`;
      source = pack.progress?.file ?? null; counter = pack.progress?.received ?? 0;
      // JSON progress is decoded bytes; gzip can inflate its apparent wire rate.
      active = true; measurable = kind === 'bioclip2' && pack.progress?.phase === 'downloading';
    }
  }
  if (!active && input.photos.transfer && ['checking', 'downloading'].includes(input.photos.phase)) {
    stage = `photos:${input.photos.transfer.id}:${input.photos.phase === 'checking' ? 'metadata' : 'images'}`; source = stage;
    counter = input.photos.transfer.received; active = true; measurable = input.photos.phase === 'downloading';
  }
  if (input.photos.phase === 'ready') remainingBytes -= Math.max(0, photoBytes - input.photos.progress.received);
  return { stage, source, counter, active, measurable, remainingBytes: Math.max(0, remainingBytes), totalBytes };
}

/** Accumulate network deltas only; checking/cache prefixes rebase the counter.
 * The current stage's effective rate extrapolates over every remaining stage.
 * Five seconds, two increments and 64 KiB establish a deliberately rough rate. */
export class DownloadEstimator {
  private stage: string | null = null;
  private source: string | null = null;
  private previous = 0;
  private measurable = false;
  private network = 0;
  private increments = 0;
  private lastProgress: number | null = null;
  private points: { at: number; bytes: number }[] = [];

  reset() {
    this.stage = null; this.source = null; this.previous = 0; this.measurable = false;
    this.network = 0; this.increments = 0; this.lastProgress = null; this.points = [];
  }

  observe(sample: DownloadObservation, now: number, online: boolean, visible: boolean): DownloadEstimate {
    const empty = { seconds: null, label: online && visible && sample.remainingBytes > 0 && sample.active ? 'Estimating…' : null,
      remainingBytes: sample.remainingBytes, totalBytes: sample.totalBytes };
    if (!online || !visible || !sample.active || !sample.stage || sample.remainingBytes <= 0 || !Number.isFinite(sample.counter) || sample.counter < 0) {
      this.reset(); return empty;
    }
    if (sample.stage !== this.stage || sample.counter < this.previous || this.lastProgress !== null && now - this.lastProgress >= 10_000) this.reset();
    if (this.stage === null) { this.stage = sample.stage; this.points.push({ at: now, bytes: 0 }); }
    const delta = sample.measurable && this.measurable && sample.source === this.source ? sample.counter - this.previous : 0;
    this.previous = sample.counter; this.source = sample.source; this.measurable = sample.measurable;
    if (delta > 0) {
      this.network += delta; this.increments++; this.lastProgress = now;
      this.points.push({ at: now, bytes: this.network });
    }
    while (this.points.length > 1 && this.points[1].at <= now - 30_000) this.points.shift();
    const first = this.points[0];
    const elapsed = now - first.at, bytes = this.network - first.bytes;
    if (!sample.measurable || elapsed < 5_000 || this.increments < 2 || bytes < 65_536 || this.lastProgress === null) return empty;
    const rate = bytes / (elapsed / 1_000);
    if (!(rate > 0) || !Number.isFinite(rate)) return empty;
    const raw = sample.remainingBytes / rate;
    const seconds = raw <= 60 ? Math.max(10, Math.ceil(raw / 10) * 10) : raw <= 600 ? Math.ceil(raw / 60) * 60 : Math.ceil(raw / 300) * 300;
    const amount = seconds < 60 ? seconds : seconds / 60;
    return { seconds, label: `About ${amount} ${seconds < 60 ? 'seconds' : amount === 1 ? 'minute' : 'minutes'} remaining`,
      remainingBytes: sample.remainingBytes, totalBytes: sample.totalBytes };
  }
}

export function useDownloadEstimate(input: DownloadEstimateInput): DownloadEstimate {
  const observation = downloadObservation(input);
  const latest = useRef(observation); latest.current = observation;
  const estimator = useRef(new DownloadEstimator());
  const tick = useRef<() => void>(() => undefined);
  const [estimate, setEstimate] = useState<DownloadEstimate>({ seconds: null, label: null, remainingBytes: observation.remainingBytes, totalBytes: observation.totalBytes });
  useEffect(() => {
    const update = () => {
      const next = estimator.current.observe(latest.current, performance.now(), navigator.onLine, document.visibilityState === 'visible');
      setEstimate(previous => Object.keys(next).every(key => previous[key as keyof DownloadEstimate] === next[key as keyof DownloadEstimate]) ? previous : next);
    };
    const restart = () => { estimator.current.reset(); update(); };
    tick.current = update;
    const timer = setInterval(update, 1_000);
    window.addEventListener('offline', restart); window.addEventListener('online', restart); document.addEventListener('visibilitychange', restart);
    update();
    return () => {
      clearInterval(timer); tick.current = () => undefined; estimator.current.reset();
      window.removeEventListener('offline', restart); window.removeEventListener('online', restart); document.removeEventListener('visibilitychange', restart);
    };
  }, []);
  useEffect(() => { tick.current(); }, [observation.stage, observation.source, observation.counter, observation.active, observation.measurable, observation.remainingBytes, observation.totalBytes]);
  return estimate;
}
