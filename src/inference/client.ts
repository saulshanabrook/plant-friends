import type { CatalogEntry } from '../assets/manifest';
import type { InstalledPack } from '../assets/storage';
import type { InferenceResult, RuntimeInfo, WorkerCommand, WorkerReply } from './protocol';

export class InferenceClient {
  private worker = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' });
  private sequence = 0;
  private currentPhoto: number | null = null;
  private failure: Error | null = null;
  private waiting = new Map<number, { resolve: (value: RuntimeInfo | InferenceResult) => void; reject: (error: Error) => void }>();
  onDeviceLost?: (message: string) => void;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'device-lost') { this.onDeviceLost?.(reply.message); return; }
      const request = this.waiting.get(reply.id);
      if (!request) return; // Replaced/reset requests have already been rejected.
      this.waiting.delete(reply.id);
      if (reply.type === 'error') {
        const error = new Error(reply.message);
        error.name = reply.code === 'canceled' ? 'AbortError' : reply.code;
        if (reply.detail) console.error(reply.code, reply.detail);
        request.reject(error);
      } else request.resolve(reply.result);
    };
    this.worker.onerror = event => {
      if (this.failure) return;
      this.failure = new Error(`Identification worker failed: ${event.message}. Reload the identification model to retry.`);
      this.worker.terminate();
      this.currentPhoto = null;
      for (const pending of this.waiting.values()) pending.reject(this.failure);
      this.waiting.clear();
    };
  }

  load(model: InstalledPack, catalog: InstalledPack, index: CatalogEntry[], options: { diagnostics?: boolean } = {}): Promise<RuntimeInfo> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve: value => resolve(value as RuntimeInfo), reject });
      this.worker.postMessage({ type: 'load', id, model, catalog, index, diagnostics: options.diagnostics } satisfies WorkerCommand);
    });
  }

  identify(input: Blob | Float32Array, options: { profile?: boolean } = {}): Promise<InferenceResult> {
    if (this.failure) return Promise.reject(this.failure);
    this.cancel();
    const id = ++this.sequence;
    this.currentPhoto = id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve: value => resolve(value as InferenceResult), reject });
      if (input instanceof Float32Array) {
        const tensor = input.buffer instanceof ArrayBuffer ? input : new Float32Array(input);
        this.worker.postMessage({ type: 'tensor', id, tensor, profile: options.profile } satisfies WorkerCommand, [tensor.buffer as ArrayBuffer]);
      } else this.worker.postMessage({ type: 'identify', id, photo: input, profile: options.profile } satisfies WorkerCommand);
    });
  }

  cancel(): void {
    if (this.currentPhoto !== null) {
      this.waiting.get(this.currentPhoto)?.reject(new DOMException('Photo replaced or cleared.', 'AbortError'));
      this.waiting.delete(this.currentPhoto);
      this.currentPhoto = null;
    }
    if (!this.failure) this.worker.postMessage({ type: 'cancel' } satisfies WorkerCommand);
  }

  dispose(): void {
    this.failure ??= new DOMException('Identification closed.', 'AbortError');
    this.worker.terminate();
    for (const pending of this.waiting.values()) pending.reject(new DOMException('Identification closed.', 'AbortError'));
    this.waiting.clear();
  }
}
