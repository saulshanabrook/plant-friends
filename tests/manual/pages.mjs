// Verify the built app at an origin root or project-site prefix using real assets.
// Usage: node tests/manual/pages.mjs <read-only-public-assets> <base> <json-report> [dist-directory]
// The external assets directory is a read-only fallback, not generated or mocked data.
import { chromium, expect } from '@playwright/test';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';

const assets = resolve(process.argv[2] ?? 'public');
const base = process.argv[3] ?? '/plant-friends/';
const output = resolve(process.argv[4] ?? 'reports/pages-path-verification.json');
const dist = resolve(process.argv[5] ?? 'dist');
if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw new Error('Use a root or slash-terminated project path.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const served = [];
const blockedModelBodies = [];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith(base)) { response.writeHead(404).end(); return; }
    const relative = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
    if (request.method === 'GET' && /(?:\.(onnx|f32|wasm|mjs)$|\/rows\.json$)/.test(relative) && /^(packs|runtime)\//.test(relative)) {
      blockedModelBodies.push(url.pathname); response.writeHead(503).end(); return;
    }
    let path = resolve(dist, relative);
    if (!path.startsWith(`${dist}${sep}`)) { response.writeHead(404).end(); return; }
    let info;
    try { info = await stat(path); }
    catch {
      if (!['catalog.json', 'model.json'].includes(relative) && !/^(packs|runtime)\//.test(relative)) throw new Error('Not a published asset');
      path = resolve(assets, relative);
      if (!path.startsWith(`${assets}${sep}`)) throw new Error('Invalid asset path');
      info = await stat(path);
    }
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    served.push({ path: url.pathname, method: request.method, bytes: info.size });
    response.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
    if (request.method === 'HEAD') response.end();
    else createReadStream(path).pipe(response);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const home = `${origin}${base}`;
const report = { checkedAt: new Date().toISOString(), base, home, assetSource: assets, scope: 'Production path and automatic catalog/offline verification; model payload requests denied by fixture server, no inference/camera/phone claim', status: 'running' };
let browser, context;
try {
  const manifestResponse = await fetch(`${home}manifest.webmanifest`);
  expect(manifestResponse.ok).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe('Plant Friends');
  expect(manifest.display).toBe('standalone');
  expect(new URL(manifest.start_url, manifestResponse.url).href).toBe(home);
  expect(new URL(manifest.scope, manifestResponse.url).href).toBe(home);
  expect(new URL(manifest.id, manifestResponse.url).href).toBe(home);
  report.manifest = { url: manifestResponse.url, id: manifest.id, startUrl: manifest.start_url, scope: manifest.scope, icons: manifest.icons };
  for (const icon of manifest.icons) {
    const url = new URL(icon.src, manifestResponse.url);
    expect(url.pathname.startsWith(base)).toBe(true);
    const response = await fetch(url, { method: 'HEAD' });
    expect(response.ok, `Icon ${url.href}`).toBe(true);
    expect(response.headers.get('Content-Type')).toBe(icon.type);
  }
  const packUrls = [];
  let catalog, catalogUrl, firstEntry;
  for (const kind of ['catalog', 'model']) {
    const pointerResponse = await fetch(`${home}${kind}.json`);
    expect(pointerResponse.ok).toBe(true);
    const pointer = await pointerResponse.json();
    const manifestUrl = new URL(pointer.url, pointerResponse.url);
    expect(manifestUrl.pathname.startsWith(base)).toBe(true);
    const response = await fetch(manifestUrl);
    expect(response.ok).toBe(true);
    const pack = await response.json();
    for (const file of pack.files) {
      const url = new URL(file.url, manifestUrl);
      expect(url.origin).toBe(origin);
      expect(url.pathname.startsWith(base), `Pack path escaped ${base}: ${url.href}`).toBe(true);
      const head = await fetch(url, { method: 'HEAD' });
      expect(head.ok, `Declared asset ${url.href}`).toBe(true);
      expect(Number(head.headers.get('Content-Length'))).toBe(file.bytes);
      if (url.pathname.endsWith('.wasm')) expect(head.headers.get('Content-Type')).toBe('application/wasm');
      if (url.pathname.endsWith('.mjs')) expect(head.headers.get('Content-Type')).toBe('text/javascript');
      packUrls.push({ kind, url: url.href, bytes: file.bytes });
    }
    if (kind === 'catalog') {
      catalog = pack; catalogUrl = manifestUrl.href;
      firstEntry = (await (await fetch(new URL(pack.indexFile, manifestUrl))).json())[0];
    } else {
      expect(new URL(pack.catalog.url, manifestUrl).href).toBe(catalogUrl);
      expect(pack.catalog.fullTaxonCount).toBe(catalog.taxonCount);
    }
  }
  report.declaredAssets = { count: packUrls.length, allUnderBase: true, modelWeightsCheckedByHeadOnly: true };
  const appAssets = await readdir(resolve(dist, 'assets'));
  const worker = appAssets.find(name => /^inference\.worker-.*\.js$/.test(name));
  expect(worker).toBeTruthy();
  expect((await fetch(`${home}assets/${worker}`, { method: 'HEAD' })).ok).toBe(true);
  report.workerUrl = `${home}assets/${worker}`;

  browser = await chromium.launch({ channel: 'chrome', headless: false });
  context = await browser.newContext();
  const page = await context.newPage();
  const browserRequests = [];
  const pageErrors = [];
  report.consoleErrors = [];
  report.stage = 'load production product';
  page.on('request', request => browserRequests.push(request.url()));
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.goto(home);
  report.stage = 'install real catalog';
  console.log(JSON.stringify({ stage: report.stage, base }));
  await expect(page.getByRole('searchbox', { name: 'Search plants', exact: true })).toBeVisible({ timeout: 90_000 });
  report.stage = 'activate scoped service worker';
  report.workerRegistrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(registration => ({ scope: registration.scope, installing: registration.installing?.state, waiting: registration.waiting?.state, active: registration.active?.state })));
  await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => undefined), new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker was not ready after 15 seconds.')), 15_000))]));
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const registration = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration(location.href);
    return { scope: registration.scope, script: navigator.serviceWorker.controller.scriptURL };
  });
  expect(registration.scope).toBe(home);
  expect(registration.script).toBe(`${home}sw.js`);
  report.serviceWorker = registration;
  await expect.poll(() => blockedModelBodies.length).toBeGreaterThan(0);
  await expect(page.locator('#plants tbody img')).toHaveCount(0);
  const photoRequests = () => browserRequests.filter(value => /\/(?:photos(?:\.json|\/)|__plant-friends-photo__\/)/.test(new URL(value).pathname));
  expect(photoRequests()).toEqual([]);
  report.photoPriority = { modelPayloadBlocked: true, photoRequestsBeforeModel: [], scope: 'Strict priority only; prior full-model verification covers offline galleries.' };
  await mkdir('.cache', { recursive: true });
  report.layout = [];
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => scrollTo(0, 0));
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    await page.screenshot({ path: `.cache/minimal-${viewport.width}.png` });
    report.layout.push({ ...viewport, noPageOverflow: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await page.locator('link[rel=manifest]').getAttribute('href')).toBe(`${base}manifest.webmanifest`);
  const favicon = await page.locator('link[rel=icon]').getAttribute('href');
  expect(new URL(favicon, home).href).toBe(`${home}icon.svg`);
  for (const image of await page.locator('header img').all()) expect(await image.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  report.stage = 'offline query navigation and details';
  await context.setOffline(true);
  const offline = await page.goto(`${home}?pages-offline=new-navigation`);
  expect(offline.status()).toBe(200);
  await expect(page.locator('#plants tbody img')).toHaveCount(0);
  expect(photoRequests()).toEqual([]);
  await page.getByRole('searchbox', { name: 'Search plants' }).fill(firstEntry.scientificName);
  await page.locator('#plants tbody').getByRole('button', { name: firstEntry.scientificName, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Known hazards', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close plant details', exact: true }).click();
  await page.goto(`${home}?diagnostics=1&pages-offline=new-diagnostics`);
  await expect(page.getByRole('heading', { name: 'Plant Friends · developer checks', exact: true })).toBeVisible();
  report.stage = 'offline absent pack/runtime fetch';
  const absent = await page.evaluate(async () => {
    const results = [];
    for (const file of ['packs/not-installed/missing.bin', 'runtime/not-installed/missing.mjs']) {
      try {
        const response = await fetch(new URL(file, location.href), { signal: AbortSignal.timeout(3_000) });
        results.push({ file, unavailable: !response.ok, contentType: response.headers.get('Content-Type') });
      } catch { results.push({ file, unavailable: true }); }
    }
    return results;
  });
  expect(absent.every(result => result.unavailable && !result.contentType?.includes('text/html'))).toBe(true);
  const escaped = browserRequests.filter(value => {
    const url = new URL(value);
    return url.origin === origin && !url.pathname.startsWith(base);
  });
  expect(escaped).toEqual([]);
  const modelFileUrls = new Set(packUrls.filter(file => file.kind === 'model').map(file => file.url));
  report.modelRequests = browserRequests.filter(url => modelFileUrls.has(url));
  report.blockedModelBodies = blockedModelBodies;
  expect(served.filter(request => modelFileUrls.has(`${origin}${request.path}`) && request.method !== 'HEAD')).toEqual([]);
  expect(pageErrors).toEqual([]);
  report.offline = { newQueryNavigation: true, catalogRecords: catalog.taxonCount, detailOpened: firstEntry.scientificName, diagnosticsQuery: true, missingPackAndRuntimeFetchUnavailable: true };
  report.requests = { escapedBase: escaped, modelPayloadBodiesServed: 0, pageErrors };
  for (const file of ['attribution.html', 'third-party-notices.txt']) {
    report.stage = `offline legal resource: ${file}`;
    console.log(JSON.stringify({ stage: report.stage, base }));
    const response = await page.evaluate(file => Promise.race([
      fetch(new URL(file, location.href)).then(async response => ({ ok: response.ok, contentType: response.headers.get('Content-Type'), bytes: (await response.arrayBuffer()).byteLength })),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Offline resource ${file} did not finish after five seconds.`)), 5_000)),
    ]), file);
    expect(response.ok, `Offline legal resource ${file}`).toBe(true);
    expect(response.bytes).toBeGreaterThan(100);
  }
  report.offline.legalNotices = ['attribution.html', 'third-party-notices.txt'];
  report.stage = 'complete';
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { name: error.name, message: error.message };
} finally {
  console.log(JSON.stringify({ stage: 'verification-finished', status: report.status, base, error: report.error }));
  await context?.close();
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, base, output, error: report.error }));
process.exitCode = report.status === 'passed' ? 0 : 1;
