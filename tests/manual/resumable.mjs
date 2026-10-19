// Actual public-origin product flow: interrupt a large range, reopen the profile,
// resume durable chunks, then identify a local fixture with the network disabled.
import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const base = new URL(process.argv[2] ?? 'https://saulshanabrook.github.io/plant-friends/');
if ((base.protocol !== 'https:' && base.hostname !== '127.0.0.1') || !base.pathname.endsWith('/') || base.search || base.hash)
  throw new Error('Supply the HTTPS app directory URL, ending in /. Local loopback is also supported.');
const output = process.argv[3] ?? 'reports/resumable-public.json';
const metadata = JSON.parse(await readFile('deployment/assets.json', 'utf8'));
const manifestPath = `packs/bioclip2/${metadata.modelId}/manifest.json`;
const model = JSON.parse(await readFile(`public/${manifestPath}`, 'utf8'));
const encoder = model.model.externalData?.[0]?.file ?? model.model.file;
const encoderUrl = new URL(encoder.url, new URL(manifestPath, base)).href;
const photosPointer = JSON.parse(await readFile('public/photos.json', 'utf8'));
const photosBytes = await readFile(`public/${photosPointer.url}`);
if (createHash('sha256').update(photosBytes).digest('hex') !== photosPointer.sha256) throw new Error('Photo index hash differs.');
const photos = JSON.parse(photosBytes);
const photoUrls = [...new Set(Object.values(photos.images).map(photo => new URL(`__plant-friends-photo__/${photo.sha256}.webp`, base).href))];
const photoRequests = { interrupted: 0, resumed: 0, violations: [] };
const fixtures = JSON.parse(await readFile('fixtures/photos.json', 'utf8'));
const fixture = fixtures.photos.filter(photo => photo.expectedTaxonId !== null).at(-1);
const photoBytes = await readFile(`public/fixtures/photos/${fixture.file}`);
if (createHash('sha256').update(photoBytes).digest('hex') !== fixture.sha256) throw new Error('Fixture hash differs.');
const continuingOffline = process.argv[4] === '--continue-offline';
const prior = continuingOffline ? JSON.parse(await readFile(output, 'utf8')) : null;
if (prior && (prior.url !== base.href || prior.expectedModelId !== metadata.modelId ||
    prior.expectedCatalogId !== metadata.catalogId || !prior.offlinePhotos?.allSaved ||
    !Number.isInteger(prior.ranges?.resumed?.[0]) || prior.ranges.resumed[0] < 16 * 1024 * 1024 ||
    !prior.retainedProfile?.startsWith(join(tmpdir(), 'plant-friends-resume-'))))
  throw new Error('Offline continuation requires this gate’s retained, fully downloaded profile and matching prior evidence.');
const profile = prior?.retainedProfile ?? await mkdtemp(join(tmpdir(), 'plant-friends-resume-'));
const report = prior ?? { checkedAt: new Date().toISOString(), url: base.href, status: 'incomplete',
  scope: 'Real desktop Chrome public product download, simulated connection loss, browser restart, range resume and offline WebGPU; physical phone/screen lock untested',
  expectedModelId: metadata.modelId, expectedCatalogId: metadata.catalogId,
  fixture: { file: fixture.file, sha256: fixture.sha256, sourceUrl: fixture.sourceUrl, license: fixture.license },
  requests: [], photoRequests, ranges: { interrupted: [], resumed: [] }, pageErrors: [] };
if (prior) {
  report.verificationCorrection = { continuedAt: new Date().toISOString(), priorError: report.error,
    reason: 'Continue offline checks with the retained fully downloaded profile; preserve the original download evidence.' };
  report.status = 'incomplete'; delete report.error;
}
let context, interrupted = false, disconnect;
const deadline = setTimeout(() => { report.timeout = true; void context?.close(); }, 900_000);

// Observe the real request boundary, including service-worker requests, and cut
// connectivity only after two complete chunks precede the next range request.
function observe(browserContext, stage) {
  browserContext.on('weberror', event => report.pageErrors.push(event.error().message));
  browserContext.on('request', request => {
    const range = request.headers().range;
    if (/\/photos\/.+\.webp$/.test(request.url())) {
      report.photoRequests[stage]++;
      const url = new URL(request.url());
      if (request.method() !== 'GET' || request.postData() || url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
        report.photoRequests.violations.push({ url: url.href, method: request.method(), hasBody: Boolean(request.postData()) });
      return;
    }
    report.requests.push({ stage, url: request.url(), method: request.method(), hasBody: Boolean(request.postData()), ...(range ? { range } : {}) });
    if (request.url() !== encoderUrl || !range) return;
    const offset = Number(/^bytes=(\d+)-/.exec(range)?.[1]);
    if (!Number.isFinite(offset)) return;
    report.ranges[stage].push(offset);
    if (stage === 'interrupted' && !interrupted && offset >= 16 * 1024 * 1024) {
      interrupted = true;
      report.interruptedRange = range;
      disconnect = browserContext.setOffline(true);
    }
  });
}

try {
  let page;
  if (!continuingOffline) {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
    observe(context, 'interrupted');
    page = await context.newPage();
    await page.goto(base.href);
    await expect(page.getByRole('heading', { name: 'Plant Friends', exact: true })).toBeVisible();
    report.appBundle = await page.locator('script[type=module]').getAttribute('src');
    console.log('Waiting for automatic setup; interrupting the encoder after durable chunks.');
    await expect.poll(() => interrupted, { timeout: 120_000 }).toBe(true);
    await disconnect;
    await expect(page.locator('.diagnostics')).toContainText('Offline');
    await expect(page.locator('.diagnostics')).not.toContainText(metadata.modelId);
    report.interruptedUI = await page.getByRole('status').allTextContents();
    report.savedBeforeRestart = await page.evaluate(async hash => {
      const results = [];
      for (const name of await caches.keys()) {
        const keys = (await (await caches.open(name)).keys()).map(request => request.url).filter(url => url.includes(hash));
        if (keys.length) results.push({ cache: name, keys });
      }
      return results;
    }, encoder.sha256);
    expect(report.savedBeforeRestart.length).toBeGreaterThan(0);
    await context.close();
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
    observe(context, 'resumed');
    page = await context.newPage();
    await page.goto(base.href);
    const resumedAt = performance.now();
    console.log('Reopened the same profile; waiting for resumed setup to finish.');
    await expect(page.locator('.diagnostics')).toContainText(metadata.modelId, { timeout: 300_000 });
    await expect(page.locator('.diagnostics')).toContainText(metadata.catalogId);
    expect(report.ranges.resumed.length).toBeGreaterThan(0);
    expect(report.ranges.resumed[0]).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(report.ranges.resumed.includes(0)).toBe(false);
    report.resumeMs = performance.now() - resumedAt;
    report.completedUI = await page.getByRole('status').allTextContents();
    console.log('Model ready; waiting for every reference photo to be saved.');
    await expect.poll(() => page.evaluate(async expected => {
      const found = new Set(); const wanted = new Set(expected);
      for (const name of await caches.keys())
        for (const request of await (await caches.open(name)).keys())
          if (wanted.has(request.url)) found.add(request.url);
      return found.size;
    }, photoUrls), { timeout: 420_000, intervals: [1_000, 2_000, 5_000] }).toBe(photoUrls.length);
    report.offlinePhotos = { id: photos.id, manifestSha256: photosPointer.sha256,
      uniqueFiles: photoUrls.length, bytes: photos.counts.photoBytes, allSaved: true };
    report.allAssetsSavedUI = await page.getByRole('status').allTextContents();
    report.serviceWorker = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      return { scope: r.scope, script: r.active?.scriptURL, secureContext: isSecureContext };
    });
    expect(report.serviceWorker).toEqual({ scope: base.href, script: new URL('sw.js', base).href, secureContext: true });
  } else {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
    observe(context, 'resumed');
    page = await context.newPage();
  }
  await context.setOffline(true);
  await page.goto(new URL('?diagnostics=1', base).href);
  await page.waitForFunction(() => Boolean(window.plantFriends));
  report.runtime = await page.evaluate(() => window.plantFriends.load());
  expect(report.runtime.executionProvider).toBe('webgpu');
  expect(report.runtime.adapter.isFallbackAdapter).toBe(false);
  expect(report.runtime.packId).toBe(metadata.modelId);
  await page.close();
  page = await context.newPage();
  await page.goto(new URL('?offline-resume-check=1', base).href);
  await page.getByLabel('Upload photo', { exact: true }).setInputFiles({ name: 'offline-plant.jpg', mimeType: 'image/jpeg', buffer: photoBytes });
  await expect(page.locator('.candidate-list > li')).toHaveCount(5, { timeout: 60_000 });
  report.automaticIdentification = true;
  report.offlineCandidates = await page.locator('.candidate-list > li').allTextContents();
  const picturedMatch = page.locator('.candidate-list > li').filter({ has: page.locator('img') }).first();
  const matchImage = picturedMatch.locator('img');
  await matchImage.scrollIntoViewIfNeeded();
  await expect.poll(() => matchImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await picturedMatch.getByRole('button').click();
  await expect(page.getByRole('heading', { name: 'Known hazards', exact: true })).toBeVisible();
  report.offlinePlant = await page.locator('#plant-title').innerText();
  const recordImage = page.locator('.plant-dialog img').first();
  await recordImage.scrollIntoViewIfNeeded();
  await expect.poll(() => recordImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: 'Close plant details', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search plants', exact: true });
  await expect(page.getByRole('combobox', { name: 'Family', exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#plants tbody tr')).toHaveCount(50);
  await page.getByRole('button', { name: /^Edibility(?: ↑| ↓)?$/, exact: true }).click();
  await expect(page.getByRole('columnheader', { name: /^Edibility/ })).toHaveAttribute('aria-sort', 'ascending');
  await page.getByRole('combobox', { name: 'Minimum edibility', exact: true }).selectOption('3');
  await page.getByRole('combobox', { name: 'Family', exact: true }).selectOption('Urticaceae');
  await search.fill('Urtica dioica');
  await expect(page.locator('#plants tbody')).toContainText('Urtica dioica');
  const tableImage = page.locator('#plants tbody img').first();
  await tableImage.scrollIntoViewIfNeeded();
  await expect.poll(() => tableImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  report.offlineTable = { sort: true, familyAndRatingFilter: true, search: true, boundedRows: 50 };
  report.offlinePhotos.matchRecordAndTableVisible = true;
  await page.getByRole('link', { name: 'Sources & licenses', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sources and licenses', exact: true })).toBeVisible();
  report.offlineLegalNotices = await page.evaluate(async () => (await fetch('third-party-notices.txt')).ok);
  expect(report.offlineLegalNotices).toBe(true);
  report.privacy = {
    allReadOnly: report.requests.every(r => ['GET', 'HEAD'].includes(r.method) && !r.hasBody),
    allAppOrigin: report.requests.every(r => !/^https?:/.test(r.url) || new URL(r.url).origin === base.origin),
    allAppPaths: report.requests.every(r => !/^https?:/.test(r.url) || new URL(r.url).pathname.startsWith(base.pathname)),
  };
  expect(report.privacy).toEqual({ allReadOnly: true, allAppOrigin: true, allAppPaths: true });
  expect(report.photoRequests.violations).toEqual([]);
  expect(report.pageErrors).toEqual([]);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { name: error.name, message: error.message }; process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await context?.close();
  if (report.status === 'passed') { await rm(profile, { recursive: true, force: true }); report.profileRemoved = true; delete report.retainedProfile; }
  else report.retainedProfile = profile;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, output, resumedFirstOffset: report.ranges.resumed[0], offlinePlant: report.offlinePlant, error: report.error }));
