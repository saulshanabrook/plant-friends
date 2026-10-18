import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogEntry, PackManifest } from './assets/manifest';
import { InferenceClient } from './inference/client';
import { imageDimensions } from './inference/preprocess';
import type { InferenceResult, RuntimeInfo } from './inference/protocol';
import { PlantDetails } from './features/PlantDetails';
import { useOfflinePacks } from './features/useOfflinePacks';

interface Photo { blob: Blob; name: string; url: string; width: number; height: number }
interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
type View = 'identify' | 'catalog' | 'setup';
type PackState = ReturnType<typeof useOfflinePacks>['packs'][PackManifest['kind']];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 3 ? 2 : 1)} ${['bytes', 'KiB', 'MiB', 'GiB'][exponent]}`;
}

function PackCard({ kind, pack, prerequisite, onInstall, onRemove, onCancel }: {
  kind: PackManifest['kind']; pack: PackState; prerequisite: string | null;
  onInstall: () => void; onRemove: () => void; onCancel: () => void;
}) {
  const [consent, setConsent] = useState(false);
  const manifest = pack.available?.manifest ?? pack.installed?.manifest;
  const bytes = manifest?.files.reduce((sum, file) => sum + file.bytes, 0);
  useEffect(() => { setConsent(false); }, [manifest?.id, prerequisite]);
  const installedCurrent = pack.installed?.manifest.id === manifest?.id;
  const isModel = kind === 'bioclip2';
  const percent = pack.progress ? Math.min(100, Math.round(pack.progress.received / pack.progress.total * 100)) : 0;
  return <section className="pack-card">
    <div className="pack-card-top"><span className="pack-symbol" aria-hidden="true">{isModel ? '✳' : '▤'}</span><span className={`status-pill ${pack.installed ? 'ready' : ''}`}>{pack.downloading ? 'Downloading' : pack.checking ? 'Checking' : pack.installed ? 'Installed' : 'Not installed'}</span></div>
    <h3>{isModel ? 'On-device identification' : 'PFAF plant catalog'}</h3>
    <p>{isModel ? 'Download BioCLIP 2 to this browser for offline identification. Your photos stay on this device.' : 'Search plant names and read hazards, ratings, and uses with no identification model required.'}</p>
    {manifest && <p className="pack-size"><strong>{bytes === undefined ? 'Size unavailable' : formatBytes(bytes)}</strong>{manifest.kind === 'pfaf' && <span> · {manifest.taxonCount.toLocaleString()} catalog records</span>}{manifest.kind === 'bioclip2' && <span> · {manifest.catalog.taxonCount.toLocaleString()} ranking entries</span>}</p>}
    {pack.installed && <p className="small muted">Verified files saved on this device.{!pack.installed.persistent && ' Your browser may clear them when storage is needed.'}</p>}
    {pack.downloading ? <div className="download-status" role="status"><div className="progress-label"><span>{pack.progress ? `${formatBytes(pack.progress.received)} of ${formatBytes(pack.progress.total)}` : 'Preparing verified download…'}</span><strong>{percent}%</strong></div><progress max="100" value={percent} aria-label={`${isModel ? 'Identification pack' : 'Catalog'} download`} /><button className="button secondary" onClick={onCancel}>Cancel download</button></div> : <>
      {!installedCurrent && pack.available && isModel && <label className="consent"><input type="checkbox" checked={consent} disabled={Boolean(prerequisite)} aria-describedby={prerequisite ? 'model-catalog-prerequisite' : undefined} onChange={event => setConsent(event.target.checked)} /><span>I want to download {bytes === undefined ? 'the' : formatBytes(bytes)} to this device for local identification.</span></label>}
      {prerequisite && !installedCurrent && <p className="small muted" id="model-catalog-prerequisite">{prerequisite}</p>}
      <div className="button-row">{pack.available && !installedCurrent && <button className="button" disabled={pack.checking || Boolean(prerequisite) || (isModel && !consent)} aria-describedby={prerequisite ? 'model-catalog-prerequisite' : undefined} onClick={onInstall}>{pack.installed ? 'Download update' : isModel ? 'Download identification pack' : 'Download PFAF catalog'}</button>}{pack.installed && <button className="text-button danger" disabled={pack.checking} onClick={onRemove}>Delete {isModel ? 'identification pack' : 'catalog'}</button>}</div>
      {!manifest && !pack.checking && !pack.error && <p className="small muted">A prepared {isModel ? 'identification pack' : 'catalog'} is not available from this host yet.</p>}
    </>}
    {pack.error && <p className="error-message" role="alert">{pack.error}</p>}
  </section>;
}

export default function App() {
  const { packs, entries, refresh, install, remove, downloads, modelCatalogPrerequisite } = useOfflinePacks();
  const [view, setView] = useState<View>('identify');
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<InferenceResult | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(40);
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [shellReady, setShellReady] = useState(false);
  const [updateWorker, setUpdateWorker] = useState<ServiceWorker | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const camera = useRef<MediaStream | null>(null);
  const cameraGeneration = useRef(0);
  const photoGeneration = useRef(0);
  const inferenceOperation = useRef(0);
  const client = useRef<InferenceClient | null>(null);
  const loading = useRef<Promise<RuntimeInfo> | null>(null);
  const loadedKey = useRef<string | null>(null);
  const livePhotoUrl = useRef<string | null>(null);

  useEffect(() => {
    const change = () => setOnline(navigator.onLine);
    const prompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    const installed = () => setInstallPrompt(null);
    window.addEventListener('online', change); window.addEventListener('offline', change);
    window.addEventListener('beforeinstallprompt', prompt); window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('online', change); window.removeEventListener('offline', change);
      window.removeEventListener('beforeinstallprompt', prompt); window.removeEventListener('appinstalled', installed);
    };
  }, []);

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
    resetIdentification(); setSelected(null);
  }, [packs.pfaf.installed?.manifest.id, packs.bioclip2.installed?.manifest.id]);

  useEffect(() => () => {
    photoGeneration.current++; cameraGeneration.current++;
    camera.current?.getTracks().forEach(track => track.stop());
    client.current?.dispose();
    if (livePhotoUrl.current) URL.revokeObjectURL(livePhotoUrl.current);
  }, []);

  function resetIdentification() {
    inferenceOperation.current++;
    client.current?.dispose(); client.current = null; loading.current = null; loadedKey.current = null;
    setRuntime(null); setResult(null); setBusy(null); setPhotoError(null);
  }

  function stopCamera() {
    cameraGeneration.current++;
    camera.current?.getTracks().forEach(track => track.stop()); camera.current = null;
    if (video.current) video.current.srcObject = null;
    setCameraActive(false); setCameraStarting(false);
  }

  function resetPhoto() {
    photoGeneration.current++; inferenceOperation.current++;
    client.current?.cancel();
    setPhoto(null); setResult(null); setPhotoError(null); setBusy(null); setReadingPhoto(false);
    stopCamera();
  }

  async function choosePhoto(blob: Blob, name: string) {
    const generation = ++photoGeneration.current;
    inferenceOperation.current++; client.current?.cancel();
    setPhoto(null); setResult(null); setBusy(null); setPhotoError(null); setReadingPhoto(true);
    try {
      await imageDimensions(blob);
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const width = bitmap.width, height = bitmap.height; bitmap.close();
      if (generation !== photoGeneration.current) return;
      setPhoto({ blob, name, width, height, url: URL.createObjectURL(blob) });
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
  const webgpu = Boolean(window.isSecureContext && navigator.gpu);
  const catalogCount = entries.length || (packs.pfaf.available?.manifest.kind === 'pfaf' ? packs.pfaf.available.manifest.taxonCount : null);
  const matches = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search ? entries.filter(entry => entry.scientificName.toLocaleLowerCase().includes(search) || entry.commonName.toLocaleLowerCase().includes(search)) : entries;
  }, [entries, query]);
  const indexById = useMemo(() => new Map(entries.map(entry => [entry.id, entry])), [entries]);

  async function identify() {
    if (!photo || !catalog || !model || !compatible || busy) return;
    const generation = photoGeneration.current;
    const operation = ++inferenceOperation.current;
    setPhotoError(null); setResult(null); setBusy('Loading the identification model…');
    let currentClient = client.current;
    if (!currentClient) {
      currentClient = new InferenceClient(); client.current = currentClient;
      currentClient.onDeviceLost = message => {
        if (client.current !== currentClient) return;
        photoGeneration.current++; inferenceOperation.current++;
        currentClient?.dispose(); client.current = null; loading.current = null; loadedKey.current = null;
        setRuntime(null); setBusy(null); setResult(null); setPhotoError(`${message} Retry identification to reload the model. Catalog browsing is still available.`);
      };
    }
    try {
      const key = `${model.manifest.id}:${catalog.manifest.id}`;
      if (loadedKey.current !== key) {
        if (!loading.current) loading.current = currentClient.load(model, catalog, entries);
        const info = await loading.current;
        if (client.current !== currentClient) return;
        loadedKey.current = key; loading.current = null; setRuntime(info);
      }
      if (generation !== photoGeneration.current || operation !== inferenceOperation.current) return;
      setBusy('Finding possible catalog matches…');
      const identified = await currentClient.identify(photo.blob);
      if (generation === photoGeneration.current && operation === inferenceOperation.current) setResult(identified);
    } catch (error) {
      if (client.current === currentClient) loading.current = null;
      if (generation === photoGeneration.current && operation === inferenceOperation.current && !(error instanceof Error && error.name === 'AbortError'))
        setPhotoError(error instanceof Error ? error.message : 'Identification failed. Retry, or browse the catalog.');
    } finally { if (operation === inferenceOperation.current) setBusy(null); }
  }

  const downloading = packs.pfaf.downloading || packs.bioclip2.downloading;
  const checking = packs.pfaf.checking || packs.bioclip2.checking;

  return <div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to content</a>
    <header className="site-header">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setView('identify'); }}><img src={`${import.meta.env.BASE_URL}icon.svg`} width="38" height="38" alt="" /><span>Plant Friends<small>A little closer to the natural world</small></span></a>
      <nav aria-label="Main navigation">{([{ id: 'identify', label: 'Identify' }, { id: 'catalog', label: 'Explore plants' }, { id: 'setup', label: 'Offline setup' }] as const).map(item => <button key={item.id} aria-current={view === item.id ? 'page' : undefined} onClick={() => { setView(item.id); stopCamera(); }}>{item.label}</button>)}</nav>
    </header>
    <div className="connection-bar"><span className="connection-dot" aria-hidden="true" />{online ? 'Photos stay on your device' : 'You’re offline · photos stay on your device'}<span className="connection-extra">{entries.length ? `${entries.length.toLocaleString()} PFAF records saved` : 'Single photo · local identification'}</span></div>
    {updateWorker && <div className="update-banner" role="status"><span>An app update is ready. Reload when your current work is finished.</span><button className="button secondary" onClick={() => { window.dispatchEvent(new Event('plant-friends-update')); updateWorker.postMessage({ type: 'SKIP_WAITING' }); }}>Reload to update</button></div>}
    <main id="main-content">
      {view === 'identify' && <>
        <section className="intro"><p className="eyebrow">Curiosity starts with one photo</p><h1>Meet the plants<br /><em>around you.</em></h1><p>Find possible matches, then get to know their names, uses, and hazards in Plants For A Future.</p></section>
        <div className="identify-layout"><section className="photo-card" aria-labelledby="photo-heading">
          <div className="section-heading"><div><span className="step-number">1</span><h2 id="photo-heading">Choose a plant photo</h2></div>{(photo || cameraActive || cameraStarting) && <button className="text-button" onClick={resetPhoto}>Reset</button>}</div>
          <p className="muted photo-guidance">One clear photo, with the plant filling the frame. Include distinctive leaves or flowers.</p>
          <div className={`photo-stage ${photo || cameraActive ? 'has-photo' : ''}`}>
            {cameraActive ? <video ref={video} autoPlay muted playsInline aria-label="Live camera preview" /> : photo ? <img src={photo.url} alt="Selected plant to identify" /> : <div className="photo-placeholder"><svg viewBox="0 0 120 120" aria-hidden="true"><path d="M60 101V55M60 74C30 75 18 56 22 34c26-3 42 11 38 35M61 55C61 31 77 18 101 21c3 26-10 44-38 43" /><path className="leaf-vein" d="m27 39 31 30m38-42L64 59" /></svg><strong>{readingPhoto ? 'Opening your photo…' : cameraStarting ? 'Opening camera…' : 'A new discovery awaits'}</strong><span>Your photo is used only in this session.</span></div>}
            {photo && <span className="photo-label">{photo.name} · {photo.width.toLocaleString()} × {photo.height.toLocaleString()}</span>}
          </div>
          <div className="photo-actions">{cameraActive ? <><button className="button" onClick={() => void capturePhoto()}>Capture still photo</button><button className="button secondary" onClick={stopCamera}>Close camera</button></> : <>{cameraStarting ? <button className="button secondary" onClick={stopCamera}>Cancel camera</button> : <button className="button secondary" onClick={() => void startCamera()} disabled={readingPhoto}>Use camera</button>}<label className={`button ${readingPhoto ? 'disabled' : ''}`}>{photo ? 'Replace photo' : 'Upload photo'}<input className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" disabled={readingPhoto} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void choosePhoto(file, file.name); }} /></label></>}</div>
          <p className="small muted photo-formats">JPEG, PNG, or WebP · up to 20 MiB and 24 megapixels</p>
          {photoError && <div className="error-message" role="alert"><p>{photoError}</p>{model && <button className="text-button" onClick={resetIdentification}>Reload identification model</button>}</div>}
          <div className="identify-action"><div><span className="step-number">2</span><h2>Look for possible matches</h2></div><button className="button identify-button" disabled={!photo || !compatible || !webgpu || Boolean(busy) || readingPhoto} onClick={() => void identify()}>{busy ?? 'Identify this photo'}{!busy && <span aria-hidden="true"> ↗</span>}</button>{busy && <button className="text-button" onClick={() => { inferenceOperation.current++; client.current?.cancel(); setBusy(null); }}>Cancel identification</button>}
          <p className="small muted">{!catalog ? 'Download the PFAF catalog in Offline setup to get started.' : !model ? 'Download the identification pack in Offline setup to enable photo matching.' : !compatible ? 'Your catalog and identification pack do not match. Install compatible packs in Offline setup.' : !webgpu ? 'Photo identification needs a secure browser with WebGPU. You can still explore every saved catalog record.' : modelManifest && modelManifest.catalog.taxonCount !== entries.length ? `This pack ranks ${modelManifest.catalog.taxonCount.toLocaleString()} of ${entries.length.toLocaleString()} saved catalog entries.` : 'The model runs locally. The first identification takes longer while it loads.'}</p>
          {(!catalog || !model || !compatible) && <button className="text-button" onClick={() => { setView('setup'); stopCamera(); }}>Open offline setup →</button>}</div>
        </section>
        <aside className="discovery-column">{result ? <section className="results-panel" aria-labelledby="results-heading" aria-live="polite"><p className="eyebrow">Look closer</p><h2 id="results-heading">Possible catalog matches</h2><p className="muted">Ranked by cosine similarity to this photo. Scores are similarities, not probabilities or confirmed identifications.</p><ol className="candidate-list">{result.candidates.map((candidate, position) => {
          const entry = indexById.get(candidate.taxonId);
          return <li key={candidate.taxonId}><button onClick={() => { if (entry) setSelected(entry); }} disabled={!entry}><span className="candidate-rank">{position + 1}</span><span className="candidate-name"><strong>{entry?.scientificName ?? 'Record unavailable'}</strong><span>{entry?.commonName || 'Common name unavailable'}</span></span><span className="candidate-score"><strong>{candidate.similarity.toFixed(3)}</strong><small>similarity</small></span><span className="candidate-arrow" aria-hidden="true">↗</span></button></li>;
        })}</ol><p className="small muted">The closest match may still be wrong. Plants outside the installed catalog can also produce matches.</p></section> : <section className="field-note"><span className="note-mark" aria-hidden="true">✳</span><p className="eyebrow">A field guide, in your pocket</p><h2>Stay curious.<br />Look closely.</h2><p>Plant Friends compares your photo with the installed PFAF catalog. A match is a starting point for learning.</p><div className="note-divider" /><p className="small">A photo cannot establish whether a plant is safe to consume or use medicinally. Check the hazards and consult a qualified expert.</p></section>}
        <section className="catalog-teaser"><p className="eyebrow">Plants For A Future</p><h2>{catalogCount ? <>{catalogCount.toLocaleString()}<span> catalog records to explore</span></> : <>A world of plants<span> waiting to be explored</span></>}</h2><p>Search scientific and common names. Open plant details even without photo identification.</p><button className="text-button" onClick={() => { setView('catalog'); stopCamera(); }}>Explore the catalog →</button></section></aside></div>
      </>}
      {view === 'catalog' && <section className="catalog-view"><div className="page-heading"><p className="eyebrow">Plants For A Future</p><h1>Your offline plant library.</h1><p>Browse names, read the source records, and keep learning.</p></div>{entries.length ? <><label className="search-label" htmlFor="plant-search">Search scientific or common names</label><div className="search-field"><span aria-hidden="true">⌕</span><input id="plant-search" type="search" value={query} placeholder="Try oak, mint, or Quercus…" onChange={event => { setQuery(event.target.value); setVisibleCount(40); }} /></div><div className="catalog-list-heading"><p role="status">{matches.length.toLocaleString()} {query ? 'matching' : 'saved'} {matches.length === 1 ? 'record' : 'records'}</p><span>Names preserved from PFAF</span></div>{matches.length ? <ul className="catalog-list">{matches.slice(0, visibleCount).map(entry => <li key={entry.id}><button onClick={() => setSelected(entry)}><span className="catalog-leaf" aria-hidden="true">⌁</span><span><strong>{entry.scientificName}</strong><span>{entry.commonName || 'Common name unavailable'}</span></span><span className="catalog-open" aria-hidden="true">↗</span></button></li>)}</ul> : <div className="empty-state"><h2>No matching names</h2><p>Try part of a scientific name or a different common name. Common names vary by region.</p><button className="button secondary" onClick={() => setQuery('')}>Clear search</button></div>}{matches.length > visibleCount && <button className="button secondary load-more" onClick={() => setVisibleCount(count => count + 40)}>Show 40 more records</button>}</> : <div className="empty-state"><span className="empty-symbol" aria-hidden="true">▤</span><h2>{packs.pfaf.checking ? 'Checking your saved catalog…' : 'Bring the plant library offline'}</h2><p>Download the PFAF text catalog once to search names and open every saved record. Photo identification is optional.</p>{!packs.pfaf.checking && <button className="button" onClick={() => setView('setup')}>Set up the catalog</button>}</div>}</section>}
      {view === 'setup' && <section className="setup-view"><div className="page-heading"><p className="eyebrow">Ready for the next walk</p><h1>Make yourself at home.<br /><em>Then take it offline.</em></h1><p>The app, plant catalog, and identification model are saved separately on this device.</p></div><section className="shell-status"><div><span className="step-number">✓</span><div><h2>Plant Friends app</h2><p>{shellReady ? 'The app shell is saved for offline use.' : import.meta.env.DEV ? 'Use the production build to save the app for offline use.' : 'The app shell has not finished saving for offline use. Keep this page open and reload after setup.'}</p></div></div>{installPrompt && <button className="button secondary" onClick={() => { void installPrompt.prompt().then(() => installPrompt.userChoice).catch(error => console.error('App installation prompt failed', error)).finally(() => setInstallPrompt(null)); }}>Install app</button>}</section><div className="pack-grid">{(['pfaf', 'bioclip2'] as const).map(kind => <PackCard key={kind} kind={kind} pack={packs[kind]} prerequisite={kind === 'bioclip2' ? modelCatalogPrerequisite : null} onInstall={() => void install(kind)} onRemove={() => void remove(kind)} onCancel={() => downloads.current[kind]?.abort()} />)}</div><div className="setup-bottom"><p>After downloading, reload this app while offline to check your setup. Browser data clearing removes saved packs; you can download them again.</p><button className="text-button" disabled={downloading || checking} onClick={() => void refresh()}>{checking ? 'Checking availability…' : 'Check available downloads ↻'}</button></div><p className="small muted">Photos and camera metadata stay in this session. Plant Friends does not upload photos, keep a photo history, or send telemetry.</p></section>}
      <details className="diagnostics"><summary>Developer diagnostics</summary><p>Physical phone and home-screen performance have not been verified.</p><dl><div><dt>Connection</dt><dd>{online ? 'Online' : 'Offline'}; {window.isSecureContext ? 'secure context' : 'insecure context'}</dd></div><div><dt>Browser WebGPU API</dt><dd>{webgpu ? 'Present; real session creation still required' : 'Unavailable'}</dd></div><div><dt>Catalog</dt><dd>{catalog?.manifest.id ?? 'Not installed'} ({entries.length.toLocaleString()} index entries)</dd></div><div><dt>Identification pack</dt><dd>{model?.manifest.id ?? 'Not installed'}</dd></div><div><dt>Execution provider</dt><dd>{runtime?.executionProvider ?? 'Model not loaded'}</dd></div>{runtime && <><div><dt>Runtime</dt><dd>{runtime.runtimeVersion}</dd></div><div><dt>Initialization</dt><dd>{runtime.initializationMs.toFixed(0)} ms</dd></div></>}{result && <div><dt>Last identification</dt><dd>{result.timings.totalMs.toFixed(0)} ms total; {result.timings.preprocessingMs.toFixed(0)} ms image processing; {result.timings.inferenceMs.toFixed(0)} ms inference; {result.timings.rankingMs.toFixed(0)} ms ranking</dd></div>}</dl><a href="?diagnostics=1">Open inference benchmark →</a></details>
    </main>
    <footer className="site-footer"><span>Plant Friends <span aria-hidden="true">✳</span> Made for a closer look.</span><span>Plant records from <a href="https://pfaf.org" target="_blank" rel="noreferrer">Plants For A Future ↗</a></span></footer>
    {selected && catalog && <PlantDetails entry={selected} catalog={catalog} onClose={() => setSelected(null)} />}
  </div>;
}
