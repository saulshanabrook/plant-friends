import type { CatalogEntry } from '../assets/manifest';
import type { InstalledPack } from '../assets/storage';
import type { Candidate } from './scoring';

export type FailureCode = 'gpu-unavailable' | 'incompatible-assets' | 'model-initialization' | 'invalid-image' | 'device-lost' | 'inference-failed' | 'canceled';
export interface RuntimeInfo {
  secureContext: boolean; adapter: Record<string, unknown>; features: string[];
  limits: Record<string, number>; runtimeVersion: string; executionProvider: 'webgpu';
  initializationMs: number; modelBytes: number; packId: string; catalogId: string;
  backend: 'native-webgpu-asyncify'; deviceFeatures: string[];
}
export interface InferenceResult {
  requestId: number; packId: string; catalogId: string; inputCount: 1;
  candidates: Candidate[]; embedding: number[];
  timings: { preprocessingMs: number; inferenceMs: number; rankingMs: number; totalMs: number };
  gpuProfile?: { method: 'WebGPU dispatch calls'; dispatchCount: number; dispatchMethods: Record<string, number> };
}
export type WorkerCommand =
  | { type: 'load'; id: number; model: InstalledPack; catalog: InstalledPack; index: CatalogEntry[]; diagnostics?: boolean }
  | { type: 'identify'; id: number; photo: Blob; profile?: boolean }
  | { type: 'tensor'; id: number; tensor: Float32Array; profile?: boolean }
  | { type: 'cancel' };
export type WorkerReply =
  | { type: 'loaded'; id: number; result: RuntimeInfo }
  | { type: 'result'; id: number; result: InferenceResult }
  | { type: 'error'; id: number; code: FailureCode; message: string; detail?: string }
  | { type: 'device-lost'; message: string };
