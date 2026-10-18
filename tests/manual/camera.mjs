// Real desktop camera check. Never add fake-media flags or replace media APIs here.
// Captured stills remain in the product page only; this script writes JSON, never images.
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:4173').origin;
const output = resolve(process.argv[3] ?? 'reports/camera-native.json');
const profile = await mkdtemp(join(tmpdir(), 'plant-friends-native-camera-'));
const evidence = {
  checkedAt: new Date().toISOString(), origin,
  scope: 'Real desktop camera through the production product UI; no phone, screen-reader, or inference claim',
  profile: 'fresh regular persistent Chrome profile; removed after check',
  launch: { channel: 'chrome', headless: false, customArgs: [], fakeMediaFlagsRequested: false },
  mediaApiReplaced: false, frameArtifactSaved: false, status: 'running', actions: [],
};
let context, page;
const requests = [];
const workers = [];
const started = performance.now();

async function openCamera(action) {
  const began = performance.now();
  await page.getByRole('button', { name: 'Use camera', exact: true }).click();
  try {
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return Boolean(video && video.videoWidth > 0 && video.readyState >= 2) || Boolean(document.querySelector('.photo-card .error-message'));
    }, undefined, { timeout: 12_000 });
  } catch {
    const pending = { action, result: 'blocked', durationMs: performance.now() - began, state: 'No frame or product error after 12 seconds' };
    evidence.actions.push(pending);
    throw new Error(pending.state);
  }
  if (await page.locator('.photo-card .error-message').count()) {
    const message = await page.locator('.photo-card .error-message').innerText();
    evidence.actions.push({ action, result: 'blocked', durationMs: performance.now() - began, error: message });
    throw new Error(message);
  }
  const preview = await page.locator('video').evaluate(video => {
    const stream = video.srcObject;
    window.__nativeCameraStreams ??= [];
    window.__nativeCameraStreams.push(stream);
    return { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
      tracks: stream.getTracks().map(track => ({ kind: track.kind, readyState: track.readyState, enabled: track.enabled, muted: track.muted })) };
  });
  const frame = await page.locator('video').evaluate(video => new Promise(resolve => {
    const timer = setTimeout(() => { video.cancelVideoFrameCallback(callback); resolve({ received: false }); }, 5_000);
    const callback = video.requestVideoFrameCallback((_now, metadata) => {
      clearTimeout(timer);
      resolve({ received: true, width: metadata.width, height: metadata.height, presentedFrames: metadata.presentedFrames });
    });
  }));
  if (!frame.received) throw new Error('Native video frame callback did not arrive within five seconds.');
  evidence.actions.push({ action, result: 'passed', durationMs: performance.now() - began, preview, frame });
}

try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
  await context.grantPermissions(['camera'], { origin });
  context.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  page = await context.newPage();
  page.on('worker', worker => workers.push(worker.url()));
  await page.goto(`${origin}/`);
  const cdp = await context.newCDPSession(page);
  evidence.browser = await cdp.send('Browser.getVersion');
  await cdp.detach();
  evidence.appBundle = await page.locator('script[type=module]').getAttribute('src');
  evidence.capability = await page.evaluate(async () => ({
    secureContext: isSecureContext,
    nativeGetUserMedia: navigator.mediaDevices.getUserMedia.toString().includes('[native code]'),
    cameraPermission: (await navigator.permissions.query({ name: 'camera' })).state,
    videoInputCount: (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput').length,
  }));
  if (!evidence.capability.nativeGetUserMedia) throw new Error('The camera API is not native; this check refuses simulated media.');

  await openCamera('Open native camera and receive a real frame');
  const captureStarted = performance.now();
  await page.getByRole('button', { name: 'Capture still photo', exact: true }).click();
  const photo = page.getByRole('img', { name: 'Selected plant to identify' });
  await expect(photo).toBeVisible();
  const dimensions = await photo.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  const photoUrl = await photo.getAttribute('src');
  const captureTracks = await page.evaluate(() => window.__nativeCameraStreams.flatMap(stream => stream.getTracks().map(track => track.readyState)));
  expect(captureTracks.every(state => state === 'ended')).toBe(true);
  evidence.actions.push({ action: 'Capture one still in page memory', result: 'passed', durationMs: performance.now() - captureStarted, dimensions, trackStatesAfterCapture: captureTracks });

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(photo).toHaveCount(0);
  const released = await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, photoUrl);
  expect(released).toBe(true);
  evidence.actions.push({ action: 'Reset current photo', result: 'passed', previewRemoved: true, photoObjectUrlReleased: released });

  for (const path of ['Explore plants', 'Explore the catalog →', 'Open offline setup →']) {
    await openCamera(`Open native camera before navigation: ${path}`);
    await page.getByRole('button', { name: path, exact: true }).click();
    await expect(page.locator('video')).toHaveCount(0);
    const states = await page.evaluate(() => window.__nativeCameraStreams.flatMap(stream => stream.getTracks().map(track => track.readyState)));
    expect(states.every(state => state === 'ended')).toBe(true);
    evidence.actions.push({ action: `Navigate via ${path}`, result: 'passed', allTrackStates: states });
    await page.getByRole('button', { name: 'Identify', exact: true }).click();
  }
  evidence.storage = await page.evaluate(async () => {
    const databases = [];
    for (const database of await indexedDB.databases()) {
      if (!database.name) continue;
      const connection = await new Promise((resolve, reject) => {
        const open = indexedDB.open(database.name);
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
      });
      try {
        for (const name of Array.from(connection.objectStoreNames)) {
          const count = await new Promise((resolve, reject) => {
            const transaction = connection.transaction(name, 'readonly');
            const rows = transaction.objectStore(name).count();
            transaction.oncomplete = () => resolve(rows.result); transaction.onerror = () => reject(transaction.error);
          });
          databases.push({ database: database.name, store: name, records: count });
        }
      } finally { connection.close(); }
    }
    let photoResponses = 0;
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (/image\/(jpeg|webp)/i.test(response?.headers.get('Content-Type') ?? '')) photoResponses++;
      }
    }
    return { localStorageKeys: localStorage.length, sessionStorageKeys: sessionStorage.length, databases, cachedPhotoResponses: photoResponses };
  });
  expect(evidence.storage.localStorageKeys).toBe(0);
  expect(evidence.storage.sessionStorageKeys).toBe(0);
  expect(evidence.storage.databases.every(store => store.records === 0)).toBe(true);
  expect(evidence.storage.cachedPhotoResponses).toBe(0);
  await page.evaluate(() => { window.__nativeCameraStreams = []; });
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'blocked';
  evidence.error = { name: error.name, message: error.message };
  if (page && !page.isClosed() && await page.getByRole('button', { name: 'Cancel camera', exact: true }).count())
    await page.getByRole('button', { name: 'Cancel camera', exact: true }).click().catch(() => undefined);
} finally {
  evidence.network = { requestCount: requests.length,
    outboundRequests: requests.filter(request => /^https?:/.test(request.url) && new URL(request.url).origin !== origin).length,
    nonReadRequests: requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length,
    dedicatedWorkers: workers.length };
  if (evidence.network.outboundRequests || evidence.network.nonReadRequests || workers.length) evidence.status = 'failed';
  try { await context?.close(); }
  finally { await rm(profile, { recursive: true, force: true }); }
  evidence.temporaryProfileRemoved = true;
  evidence.durationMs = performance.now() - started;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify({ status: evidence.status, output, durationMs: evidence.durationMs, error: evidence.error }));
process.exitCode = evidence.status === 'passed' ? 0 : 2;
