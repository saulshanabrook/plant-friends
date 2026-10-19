import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogEntry } from './assets/manifest';
import { InferenceClient } from './inference/client';
import { imageDimensions } from './inference/preprocess';
import { AutomaticIdentification, type IdentificationState } from './features/automaticIdentification';
import { PlantDetails } from './features/PlantDetails';
import { PlantTable } from './features/PlantTable';
import { useOfflinePacks } from './features/useOfflinePacks';
import { usePlantPhotos } from './features/usePlantPhotos';
import { useDownloadEstimate } from './features/useDownloadEstimate';

interface Photo { id: number; blob: Blob; name: string; url: string; width: number; height: number }
interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
interface InstalledRelatedApp { platform: string; url?: string; id?: string }
function formatBytes(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }

export default function App() {
  const { packs, entries, phase, setupError, retrying, modelCurrent } = useOfflinePacks();
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [identification, setIdentification] = useState<IdentificationState>({ phase: 'idle', result: null, runtime: null, error: null });
  const { result, runtime } = identification;
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [shellReady, setShellReady] = useState(false);
  const [updateWorker, setUpdateWorker] = useState<ServiceWorker | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [appInstalled, setAppInstalled] = useState(() => Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
  const [browserDisplay, setBrowserDisplay] = useState(() => window.matchMedia('(display-mode: browser)').matches);
  const [installHelp, setInstallHelp] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const camera = useRef<MediaStream | null>(null);
  const cameraGeneration = useRef(0);
  const photoGeneration = useRef(0);
  const identifier = useRef<AutomaticIdentification | null>(null);
  const livePhotoUrl = useRef<string | null>(null);

  useEffect(() => {
    const session = new AutomaticIdentification(() => new InferenceClient(), setIdentification);
    identifier.current = session;
    return () => { session.dispose(); if (identifier.current === session) identifier.current = null; };
  }, []);

  useEffect(() => {
    let current = true;
    const change = () => setOnline(navigator.onLine);
    const prompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); setInstallHelp(null); };
    const installed = () => { setAppInstalled(true); setInstallPrompt(null); setInstallHelp(null); };
    const displayMode = window.matchMedia('(display-mode: browser)');
    const displayChanged = () => setBrowserDisplay(displayMode.matches);
    const relatedApps = (navigator as Navigator & { getInstalledRelatedApps?: () => Promise<InstalledRelatedApp[]> }).getInstalledRelatedApps;
    if (relatedApps) void Promise.resolve().then(() => relatedApps.call(navigator)).then(apps => {
      const manifestUrl = new URL(`${import.meta.env.BASE_URL}manifest.webmanifest`, location.href).href;
      const appId = new URL(import.meta.env.BASE_URL, location.href).href;
      if (current && apps.some(app => {
        if (app.platform !== 'webapp') return false;
        try {
          const manifest = app.url ? new URL(app.url, location.href) : null;
          return manifest?.href === manifestUrl || typeof app.id === 'string' && new URL(app.id, manifest ?? location.href).href === appId;
        } catch { return false; }
      })) installed();
    }).catch(() => undefined);
    window.addEventListener('online', change); window.addEventListener('offline', change);
    window.addEventListener('beforeinstallprompt', prompt); window.addEventListener('appinstalled', installed);
    displayMode.addEventListener('change', displayChanged);
    return () => {
      current = false;
      window.removeEventListener('online', change); window.removeEventListener('offline', change);
      window.removeEventListener('beforeinstallprompt', prompt); window.removeEventListener('appinstalled', installed);
      displayMode.removeEventListener('change', displayChanged);
    };
  }, []);

  async function addApp() {
    if (installPrompt) {
      setInstallPrompt(null);
      try { await installPrompt.prompt(); await installPrompt.userChoice; return; }
      catch { /* The browser's own menu remains available when prompting fails. */ }
    }
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const safari = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR/.test(navigator.userAgent);
    setInstallHelp(ios ? 'Open the Share menu, then choose Add to Home Screen.' : safari ? 'In Safari, choose File → Add to Dock.' : 'Use your browser’s Install app or Add to Home Screen option.');
  }

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    const change = (event: Event) => {
      const status = (event as CustomEvent<{ ready: boolean; waiting: ServiceWorker | null }>).detail;
      setShellReady(status.ready); setUpdateWorker(status.waiting);
    };
    window.addEventListener('plant-friends-shell', change);
    void navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL).then(registration => {
      setShellReady(Boolean(registration?.active)); setUpdateWorker(registration?.waiting ?? null);
    });
    return () => window.removeEventListener('plant-friends-shell', change);
  }, []);

  useEffect(() => {
    livePhotoUrl.current = photo?.url ?? null;
    return () => { if (photo) URL.revokeObjectURL(photo.url); };
  }, [photo]);

  useEffect(() => {
    setSelected(null);
  }, [packs.pfaf.installed?.manifest.id, packs.bioclip2.installed?.manifest.id]);

  useEffect(() => () => {
    photoGeneration.current++; cameraGeneration.current++;
    camera.current?.getTracks().forEach(track => track.stop());
    if (livePhotoUrl.current) URL.revokeObjectURL(livePhotoUrl.current);
  }, []);

  function stopCamera() {
    cameraGeneration.current++;
    camera.current?.getTracks().forEach(track => track.stop()); camera.current = null;
    if (video.current) video.current.srcObject = null;
    setCameraActive(false); setCameraStarting(false);
  }

  function resetPhoto() {
    photoGeneration.current++; identifier.current?.setPhoto(null);
    setPhoto(null); setPhotoError(null); setReadingPhoto(false);
    stopCamera();
  }

  async function choosePhoto(blob: Blob, name: string) {
    const generation = ++photoGeneration.current;
    identifier.current?.setPhoto(null);
    setPhoto(null); setPhotoError(null); setReadingPhoto(true);
    try {
      await imageDimensions(blob);
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const width = bitmap.width, height = bitmap.height; bitmap.close();
      if (generation !== photoGeneration.current) return;
      setPhoto({ id: generation, blob, name, width, height, url: URL.createObjectURL(blob) });
      stopCamera();
    } catch (error) {
      if (generation === photoGeneration.current) setPhotoError(error instanceof Error ? error.message : 'This photo could not be opened. Choose another JPEG, PNG, or WebP.');
    } finally { if (generation === photoGeneration.current) setReadingPhoto(false); }
  }

  async function startCamera() {
    resetPhoto();
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhotoError('Camera access is unavailable here. Use a secure browser connection or upload a photo.'); return;
    }
    const request = ++cameraGeneration.current;
    setCameraStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      if (request !== cameraGeneration.current) { stream.getTracks().forEach(track => track.stop()); return; }
      camera.current?.getTracks().forEach(track => track.stop()); camera.current = stream;
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
        if (camera.current !== stream) return;
        stopCamera(); setPhotoError('The camera disconnected. Retry the camera or upload a photo.');
      });
      setCameraActive(true); setCameraStarting(false);
    } catch (error) {
      if (request !== cameraGeneration.current) return;
      setCameraStarting(false);
      setPhotoError(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Camera permission was not granted. Allow camera access in your browser, or upload a photo.'
        : 'The camera could not be opened. Close other camera apps, retry, or upload a photo.');
    }
  }

  useEffect(() => {
    if (cameraActive && video.current && camera.current) {
      const stream = camera.current;
      const generation = cameraGeneration.current;
      video.current.srcObject = stream;
      void video.current.play().catch(() => {
        if (cameraGeneration.current !== generation || camera.current !== stream) return;
        stopCamera(); setPhotoError('Camera preview could not play. Retry the camera or upload a photo.');
      });
    }
  }, [cameraActive]);

  async function capturePhoto() {
    const element = video.current;
    if (!element?.videoWidth || !element.videoHeight) { setPhotoError('The camera is still starting. Wait for the preview, then try again.'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = element.videoWidth; canvas.height = element.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) { setPhotoError('This browser could not capture a still photo. Upload a photo instead.'); return; }
    context.drawImage(element, 0, 0);
    const generation = photoGeneration.current;
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    canvas.width = 1; canvas.height = 1;
    if (generation !== photoGeneration.current) return;
    if (!blob) { setPhotoError('The still photo could not be captured. Try again or upload a photo.'); return; }
    await choosePhoto(blob, 'Camera photo');
  }

  const catalog = packs.pfaf.installed;
  const model = packs.bioclip2.installed;
  const modelManifest = model?.manifest.kind === 'bioclip2' ? model.manifest : null;
  const compatible = Boolean(catalog?.manifest.kind === 'pfaf' && modelManifest && entries.length &&
    modelManifest.catalog.id === catalog.manifest.id && modelManifest.catalog.sourceSha256 === catalog.manifest.sourceSha256 &&
    modelManifest.catalog.fullTaxonCount === entries.length);
  const referencePhotos = usePlantPhotos(catalog, compatible && modelCurrent);
  const downloadEstimate = useDownloadEstimate({ packs, phase, photos: referencePhotos });
  const webgpu = Boolean(window.isSecureContext && navigator.gpu);
  const indexById = useMemo(() => new Map(entries.map(entry => [entry.id, entry])), [entries]);

  useEffect(() => {
    identifier.current?.setAssets(catalog && model && compatible && webgpu ? {
      key: JSON.stringify([model.manifest.id, model.manifestUrl, catalog.manifest.id, catalog.manifestUrl]),
      model, catalog, index: entries,
    } : null);
  }, [catalog, model, compatible, webgpu, entries]);
  useEffect(() => { identifier.current?.setPhoto(photo); }, [photo]);

  const identifying = identification.phase === 'loading' || identification.phase === 'identifying';
  const identificationStatus = identification.phase === 'loading' ? 'Loading model…' : identification.phase === 'identifying' ? 'Identifying…' :
    identification.phase === 'cancelled' ? 'Identification cancelled.' : identification.phase === 'idle' || identification.phase === 'waiting' ? 'Waiting for identification downloads…' : null;

  const downloadingPack = packs.pfaf.downloading ? packs.pfaf : packs.bioclip2.downloading ? packs.bioclip2 : null;
  const downloadProgress = downloadingPack?.progress;
  const downloadBytes = downloadingPack?.available?.manifest.files.reduce((sum, file) => sum + file.bytes, 0) ?? null;
  const preparingPhotos = referencePhotos.phase === 'checking' && referencePhotos.transfer !== null;
  const saving = phase === 'downloading' || referencePhotos.phase === 'downloading' || preparingPhotos;
  const photoSetup = preparingPhotos || referencePhotos.phase === 'downloading' || phase === 'idle' && referencePhotos.phase !== 'ready';
  const [screenAwake, setScreenAwake] = useState(false);
  useEffect(() => {
    if (!saving || !navigator.wakeLock) return;
    let current = true, pending = false;
    let lock: WakeLockSentinel | null = null;
    async function acquire() {
      if (!current || pending || lock || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const granted = await navigator.wakeLock.request('screen');
        if (!current || document.visibilityState !== 'visible') { await granted.release(); return; }
        lock = granted; setScreenAwake(true);
        granted.addEventListener('release', () => { if (lock === granted) lock = null; if (current) setScreenAwake(false); });
      } catch { /* Downloads and resume work when screen wake lock is unavailable. */ }
      finally { pending = false; }
    }
    function visibility() {
      if (document.visibilityState === 'visible') void acquire();
      else { const held = lock; lock = null; setScreenAwake(false); void held?.release().catch(() => undefined); }
    }
    void acquire();
    document.addEventListener('visibilitychange', visibility);
    return () => { current = false; document.removeEventListener('visibilitychange', visibility); setScreenAwake(false); void lock?.release().catch(() => undefined); };
  }, [saving]);

  return <>
    <header><div className="app-heading"><h1>Plant Friends</h1>{!appInstalled && browserDisplay && <button className="add-app" onClick={() => void addApp()} aria-describedby={installHelp ? 'install-help' : undefined}><img src={`${import.meta.env.BASE_URL}icon.svg`} width="20" height="20" alt="" />Add app</button>}</div>
      <p>Fully offline after download. Model: <a href="https://imageomics.github.io/bioclip-2/" target="_blank" rel="noreferrer">BioCLIP 2</a> · Data: <a href="https://pfaf.org/" target="_blank" rel="noreferrer">PFAF</a>.</p>
      {installHelp && <p id="install-help" role="status">{installHelp}</p>}
    </header>
    <main id="main-content">
      <section id="identify" aria-labelledby="photo-heading">
        <h2 id="photo-heading">Identify</h2>
        <div className="controls"><label>Upload photo <input type="file" accept="image/jpeg,image/png,image/webp" disabled={readingPhoto} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void choosePhoto(file, file.name); }} /></label>
          {cameraActive ? <><button onClick={() => void capturePhoto()}>Capture still photo</button><button onClick={stopCamera}>Close camera</button></> : cameraStarting ? <button onClick={stopCamera}>Cancel camera</button> : <button onClick={() => void startCamera()} disabled={readingPhoto}>Use camera</button>}
          {(photo || cameraActive || cameraStarting) && <button onClick={resetPhoto}>Reset</button>}
        </div>
        <p>Your photos stay in this session.</p>
        {cameraActive ? <video ref={video} autoPlay muted playsInline aria-label="Live camera preview" /> : photo ? <img className="photo-preview" src={photo.url} alt="Selected plant to identify" /> : (readingPhoto || cameraStarting) && <p role="status">{readingPhoto ? 'Opening photo…' : 'Opening camera…'}</p>}
        {photo && <p className="photo-label">{photo.name} · {photo.width.toLocaleString()} × {photo.height.toLocaleString()}</p>}
        {(photoError || identification.error) && <div role="alert"><p>{photoError ?? identification.error}</p>{identification.error && photo && <><button onClick={() => identifier.current?.retry()}>Retry identification</button>{model && <button onClick={() => identifier.current?.retry(true)}>Reload identification model</button>}</>}</div>}
        {photo && webgpu && identificationStatus && <div className="controls"><p role="status">{identificationStatus}</p>{identifying && <button onClick={() => identifier.current?.cancel()}>Cancel identification</button>}{identification.phase === 'cancelled' && <button onClick={() => identifier.current?.retry()}>Retry identification</button>}</div>}
        {!webgpu && <p>Photo identification is unavailable in this browser.</p>}
        <p>Possible matches do not confirm identity or safety for food or medicine.</p>
        {result && <section aria-labelledby="results-heading"><h3 id="results-heading">Possible catalog matches</h3><ol className="candidate-list">{result.candidates.map(candidate => {
          const entry = indexById.get(candidate.taxonId);
          const reference = referencePhotos.photosByPlant[candidate.taxonId]?.[0];
          return <li key={candidate.taxonId}>{reference && <img className="match-photo" src={reference.url} alt={`Reference for ${entry?.scientificName ?? 'catalog plant'}`} width={reference.width} height={reference.height} loading="lazy" decoding="async" />} <button disabled={!entry} onClick={() => { if (entry) { stopCamera(); setSelected(entry); } }}>{entry?.scientificName ?? 'Record unavailable'}</button> {candidate.similarity.toFixed(3)} similarity</li>;
        })}</ol></section>}
        {(phase !== 'idle' || photoSetup) && <div id="setup-status">
          <p role={phase === 'error' || photoSetup && referencePhotos.phase === 'error' ? 'alert' : 'status'}>{photoSetup ? referencePhotos.phase === 'checking' ? 'Preparing reference photos…' : referencePhotos.phase === 'downloading' ? `Reference photos: ${referencePhotos.progress.completed.toLocaleString()} / ${referencePhotos.progress.totalFiles.toLocaleString()} · ${formatBytes(referencePhotos.progress.received)} / ${formatBytes(referencePhotos.progress.total)}.` : referencePhotos.phase === 'error' ? referencePhotos.error : online ? 'Reference photo download interrupted. Reload or return to this page to continue.' : 'Waiting for connection to finish saving reference photos.' : phase === 'checking' ? 'Checking saved data…' : phase === 'downloading' ? <>Downloading {packs.pfaf.downloading ? 'plant data' : 'model'}… {formatBytes(downloadProgress?.received ?? 0)} / {downloadBytes === null ? '…' : formatBytes(downloadBytes)}.</> : phase === 'waiting' ? !online ? 'Waiting for connection; downloads resume automatically.' : retrying ? 'Download interrupted; retrying shortly.' : 'Download interrupted. Reload or return to this page to continue.' : setupError?.replace(/Could not download .+? \(HTTP (\d+)\).*$/, 'Download failed (HTTP $1). Reload this page to retry.')}{saving && downloadEstimate.label && <> {downloadEstimate.label}</>}{screenAwake && ' Screen awake.'}</p>
          {saving && <progress aria-label="Offline data download" max={preparingPhotos ? undefined : photoSetup ? referencePhotos.progress.total || 1 : downloadProgress?.total ?? 1} value={preparingPhotos ? undefined : photoSetup ? referencePhotos.progress.received : downloadProgress?.received ?? 0} />}
        </div>}
      </section>
      <section id="plants" aria-labelledby="plants-heading"><h2 id="plants-heading">Plants</h2>{catalog && entries.length ? <PlantTable entries={entries} catalog={catalog} photos={referencePhotos.photosByPlant} onSelect={entry => { stopCamera(); setSelected(entry); }} /> : <p>{packs.pfaf.checking ? 'Checking saved catalog…' : 'The plant table is available after the catalog download.'}</p>}</section>
      <details className="diagnostics"><summary>Diagnostics</summary><dl><dt>Offline setup</dt><dd>{setupError ?? phase}</dd><dt>Reference photos</dt><dd>{referencePhotos.error ?? referencePhotos.phase}; {referencePhotos.progress.completed.toLocaleString()} / {referencePhotos.progress.totalFiles.toLocaleString()} saved</dd><dt>Connection</dt><dd>{online ? 'Online' : 'Offline'}</dd><dt>App saved offline</dt><dd>{shellReady ? 'Yes' : 'Not yet'}</dd><dt>WebGPU API</dt><dd>{webgpu ? 'Present' : 'Unavailable'}</dd><dt>Catalog</dt><dd>{catalog?.manifest.id ?? 'Not installed'} ({entries.length.toLocaleString()} records)</dd><dt>Model</dt><dd>{model?.manifest.id ?? 'Not installed'}</dd><dt>Execution provider</dt><dd>{runtime?.executionProvider ?? 'Model not loaded'}</dd>{runtime && <><dt>Initialization</dt><dd>{runtime.initializationMs.toFixed(0)} ms</dd></>}{result && <><dt>Last identification</dt><dd>{result.timings.totalMs.toFixed(0)} ms</dd></>}</dl><a href="?diagnostics=1">Inference checks</a></details>
    </main>
    <footer><p><a href={`${import.meta.env.BASE_URL}attribution.html`}>Sources &amp; licenses</a></p></footer>
    {updateWorker && <p role="status">App update available. <button onClick={() => { window.dispatchEvent(new Event('plant-friends-update')); updateWorker.postMessage({ type: 'SKIP_WAITING' }); }}>Reload to update</button></p>}
    {selected && catalog && <PlantDetails entry={selected} catalog={catalog} photos={referencePhotos.photosByPlant[selected.id]} onClose={() => setSelected(null)} />}
  </>;
}
