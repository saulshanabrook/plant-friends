import type { CatalogEntry } from '../assets/manifest';
import type { InstalledPack } from '../assets/storage';
import type { InferenceResult, RuntimeInfo } from '../inference/protocol';

export interface IdentificationPhoto { id: number; blob: Blob }
export interface IdentificationAssets { key: string; model: InstalledPack; catalog: InstalledPack; index: CatalogEntry[] }
export interface IdentificationClient {
  load(model: InstalledPack, catalog: InstalledPack, index: CatalogEntry[]): Promise<RuntimeInfo>;
  identify(photo: Blob): Promise<InferenceResult>;
  cancel(): void;
  dispose(): void;
  onDeviceLost?: (message: string) => void;
}
export interface IdentificationState {
  phase: 'idle' | 'waiting' | 'loading' | 'identifying' | 'complete' | 'cancelled' | 'error';
  result: InferenceResult | null;
  runtime: RuntimeInfo | null;
  error: string | null;
}
interface Attempt { phase: 'loading' | 'identifying' | 'complete' | 'error'; result: InferenceResult | null; error: string | null }
interface Engine { key: string; client: IdentificationClient; loading: Promise<RuntimeInfo> | null; runtime: RuntimeInfo | null }

/** One attempt per selected photo/version, except an explicit retry. Loading
 * belongs to the engine, so replacing a photo never starts a second load RPC. */
export class AutomaticIdentification {
  private photo: IdentificationPhoto | null = null;
  private assets: IdentificationAssets | null = null;
  private engine: Engine | null = null;
  private attempts = new Map<string, Attempt>();
  private cancelled = false;
  private queued = false;
  private disposed = false;

  constructor(private createClient: () => IdentificationClient, private publish: (state: IdentificationState) => void) {}

  setPhoto(photo: IdentificationPhoto | null) {
    if (this.disposed || this.photo?.id === photo?.id) return;
    this.engine?.client.cancel();
    this.photo = photo; this.attempts.clear(); this.cancelled = false;
    this.emit(); this.schedule();
  }

  setAssets(assets: IdentificationAssets | null) {
    if (this.disposed) return;
    const previous = this.assets;
    this.assets = assets;
    if (previous?.key === assets?.key) return;
    const attempt = previous && this.attempts.get(previous.key);
    if (attempt && ['loading', 'identifying'].includes(attempt.phase)) {
      attempt.phase = 'error'; attempt.error = 'Identification was interrupted. Retry to try again.';
    }
    this.engine?.client.cancel();
    if (assets && this.engine?.key !== assets.key) this.discardEngine();
    this.emit(); this.schedule();
  }

  cancel() {
    if (this.disposed || !this.photo) return;
    this.cancelled = true; this.engine?.client.cancel(); this.emit();
  }

  retry(reload = false) {
    if (this.disposed || !this.photo) return;
    this.engine?.client.cancel(); this.attempts.clear(); this.cancelled = false;
    if (reload) this.discardEngine();
    this.emit(); this.schedule();
  }

  dispose() {
    this.disposed = true; this.photo = null; this.attempts.clear(); this.discardEngine();
  }

  private discardEngine() {
    // Clear identity before disposal rejects pending RPCs or a late device event.
    const previous = this.engine; this.engine = null; previous?.client.dispose();
  }

  private emit() {
    if (this.disposed) return;
    const attempt = this.photo && this.assets ? this.attempts.get(this.assets.key) : undefined;
    this.publish({ phase: !this.photo ? 'idle' : this.cancelled ? 'cancelled' : attempt?.phase ?? 'waiting',
      result: !this.cancelled ? attempt?.result ?? null : null, error: !this.cancelled ? attempt?.error ?? null : null,
      runtime: this.engine?.runtime ?? null });
  }

  private schedule() {
    if (this.queued || this.disposed) return;
    this.queued = true;
    // Effect setup/cleanup/setup can finish before any worker is created.
    queueMicrotask(() => {
      this.queued = false;
      if (this.disposed || this.cancelled || !this.photo || !this.assets || this.attempts.has(this.assets.key)) return;
      const attempt: Attempt = { phase: 'loading', result: null, error: null };
      this.attempts.set(this.assets.key, attempt);
      void this.run(this.photo, this.assets, attempt);
    });
  }

  private current(photo: IdentificationPhoto, assets: IdentificationAssets, attempt: Attempt) {
    return !this.disposed && !this.cancelled && this.photo?.id === photo.id && this.assets?.key === assets.key &&
      this.attempts.get(assets.key) === attempt && (attempt.phase === 'loading' || attempt.phase === 'identifying');
  }

  private async run(photo: IdentificationPhoto, assets: IdentificationAssets, attempt: Attempt) {
    this.emit();
    try {
      if (!this.engine) {
        const engine: Engine = { key: assets.key, client: this.createClient(), loading: null, runtime: null };
        this.engine = engine;
        engine.client.onDeviceLost = message => {
          if (this.disposed || this.engine !== engine) return;
          this.discardEngine();
          if (this.photo && this.assets && !this.cancelled) this.attempts.set(this.assets.key,
            { phase: 'error', result: null, error: `${message} Retry identification to reload the model.` });
          this.emit();
        };
      }
      const engine = this.engine;
      if (!engine.loading) engine.loading = (async () => {
        try {
          const info = await engine.client.load(assets.model, assets.catalog, assets.index);
          if (!this.disposed && this.engine === engine) { engine.runtime = info; this.emit(); }
          return info;
        } catch (error) {
          if (this.engine === engine) this.discardEngine();
          throw error;
        }
      })();
      await engine.loading;
      if (!this.current(photo, assets, attempt) || this.engine !== engine) return;
      attempt.phase = 'identifying'; this.emit();
      const result = await engine.client.identify(photo.blob);
      if (!this.current(photo, assets, attempt) || this.engine !== engine) return;
      attempt.phase = 'complete'; attempt.result = result; this.emit();
    } catch (error) {
      if (!this.current(photo, assets, attempt)) return;
      // Worker crashes are sticky in InferenceClient. A new photo or Retry must
      // get a fresh worker instead of repeatedly calling the poisoned instance.
      if (error instanceof Error && ['Error', 'device-lost'].includes(error.name)) this.discardEngine();
      attempt.phase = 'error'; attempt.error = error instanceof Error ? error.message : 'Identification failed. Retry to try again.';
      this.emit();
    }
  }
}
