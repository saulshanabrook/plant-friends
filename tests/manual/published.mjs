// Final deployment gate: real public HTTPS assets, actual WebGPU and offline UI.
// Fixture bytes are supplied locally; no fixture photos or reference tensors need hosting.
import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const base = new URL(process.argv[2] ?? 'https://saulshanabrook.github.io/plant-friends/');
if (base.protocol !== 'https:' || base.search || base.hash || !base.pathname.endsWith('/'))
  throw new Error('Supply the deployed HTTPS app directory URL, ending in /.');
const output = process.argv[3] ?? 'reports/pages-public.json';
const metadata = JSON.parse(await readFile('deployment/assets.json', 'utf8'));
const fixtures = JSON.parse(await readFile('fixtures/photos.json', 'utf8'));
const fixture = fixtures.photos.filter(photo => photo.expectedTaxonId !== null).at(-1);
const photoBytes = await readFile(`public/fixtures/photos/${fixture.file}`);
if (createHash('sha256').update(photoBytes).digest('hex') !== fixture.sha256)
  throw new Error('Local verification photograph differs from its pinned licensed fixture.');
const profile = await mkdtemp(join(tmpdir(), 'plant-friends-pages-'));
const report = { checkedAt: new Date().toISOString(), url: base.href, status: 'incomplete',
  scope: 'Published HTTPS PWA, real desktop Chrome WebGPU, fresh offline product identification; phones untested',
  expectedModelId: metadata.modelId, expectedCatalogId: metadata.catalogId,
  fixture: { file: fixture.file, sha256: fixture.sha256, sourceUrl: fixture.sourceUrl, license: fixture.license },
  requests: [], pageErrors: [] };
let context;
const deadline = setTimeout(() => { report.timeout = true; void context?.close(); }, 900_000);
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
  context.on('request', request => report.requests.push({ url: request.url(), method: request.method(), hasBody: Boolean(request.postData()) }));
  context.on('weberror', event => report.pageErrors.push(event.error().message));
  report.browser = context.browser()?.version();
  let page = await context.newPage();
  await page.goto(new URL('?diagnostics=1', base).href);
  await page.waitForFunction(() => Boolean(window.plantFriends));
  report.serviceWorker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { scope: registration.scope, script: registration.active?.scriptURL, secureContext: isSecureContext };
  });
  expect(report.serviceWorker).toEqual({ scope: base.href, script: new URL('sw.js', base).href, secureContext: true });
  const manifestUrl = await page.locator('link[rel=manifest]').getAttribute('href');
  report.manifest = await page.evaluate(async url => {
    const response = await fetch(url); if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`); return response.json();
  }, new URL(manifestUrl, base).href);
  expect(new URL(report.manifest.start_url, base).href).toBe(base.href);
  expect(new URL(report.manifest.scope, base).href).toBe(base.href);
  console.log('Installing the actual published catalog and identification pack…');
  const began = performance.now();
  report.catalog = await page.evaluate(() => window.plantFriends.install('pfaf'));
  report.model = await page.evaluate(() => window.plantFriends.install('bioclip2'));
  report.installationMs = performance.now() - began;
  expect(report.catalog.id).toBe(metadata.catalogId);
  expect(report.model.id).toBe(metadata.modelId);
  report.runtime = await page.evaluate(() => window.plantFriends.load());
  expect(report.runtime.executionProvider).toBe('webgpu');
  expect(report.runtime.adapter.isFallbackAdapter).toBe(false);
  expect(report.runtime.packId).toBe(metadata.modelId);
  await page.close();
  await context.setOffline(true);
  page = await context.newPage();
  await page.goto(new URL('?offline-deployment-check=1', base).href);
  const selected = page.getByRole('img', { name: 'Selected plant to identify' });
  await page.locator('input[type=file]').setInputFiles({ name: 'local-offline-plant.jpg', mimeType: 'image/jpeg', buffer: photoBytes });
  await expect(selected).toBeVisible();
  const identify = page.getByRole('button', { name: 'Identify this photo', exact: true });
  await expect(identify).toBeEnabled({ timeout: 30_000 });
  await identify.click();
  await expect(page.locator('.candidate-list > li')).toHaveCount(5, { timeout: 60_000 });
  report.offlineCandidates = await page.locator('.candidate-list > li').allTextContents();
  await page.locator('.candidate-list > li button').first().click();
  await expect(page.getByRole('heading', { name: 'Known hazards', exact: true })).toBeVisible();
  report.offlinePlant = await page.locator('#plant-title').innerText();
  report.offlineHazards = await page.locator('.hazard-panel').innerText();
  await page.getByRole('button', { name: 'Close plant details', exact: true }).click();
  await page.getByRole('button', { name: 'Explore plants', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search scientific or common names' }).fill('Urtica dioica');
  await expect(page.locator('.catalog-list')).toContainText('Urtica dioica');
  await page.getByRole('link', { name: 'Sources & licenses', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sources and licenses', exact: true })).toBeVisible();
  const legal = await page.evaluate(async () => { const r = await fetch('third-party-notices.txt'); return { status: r.status, text: await r.text() }; });
  expect(legal.status).toBe(200);
  expect(legal.text).toContain('BIOCLIP 2');
  expect(legal.text).toContain('PFAF TEXT DATA');
  report.offlineLegalNotices = 'passed';
  report.privacy = {
    allReadOnly: report.requests.every(request => ['GET', 'HEAD'].includes(request.method) && !request.hasBody),
    allAppOrigin: report.requests.every(request => !/^https?:/.test(request.url) || new URL(request.url).origin === base.origin),
    allAppPaths: report.requests.every(request => !/^https?:/.test(request.url) || new URL(request.url).pathname.startsWith(base.pathname)),
  };
  expect(report.privacy).toEqual({ allReadOnly: true, allAppOrigin: true, allAppPaths: true });
  expect(report.pageErrors).toEqual([]);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try { await context?.close(); } finally { await rm(profile, { recursive: true, force: true }); }
  report.profileRemoved = true;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, output, model: report.model, offlinePlant: report.offlinePlant, error: report.error }));
