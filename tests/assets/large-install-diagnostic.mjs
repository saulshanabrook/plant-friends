/** One explicit real-pack storage probe. It never loads or runs the model. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const origin = process.env.PLANT_DIAGNOSTIC_ORIGIN ?? 'http://127.0.0.1:4173';
const profile = resolve('.cache/assets-large-install-profile');
const output = resolve('tests/assets/large-install-diagnostic.json');
await mkdir(profile, { recursive: true });
const report = {
  measuredAt: new Date().toISOString(),
  question: 'Does the exact verified real-pack installer succeed in a persistent Chrome profile after an incognito Cache.put UnknownError?',
  hypotheses: [
    'Incognito in-memory Cache backend limitation: persistent profile should install the same file.',
    'Application stream/integrity bug: persistent profile should fail too.',
    'Origin quota exhaustion: estimate/CDP quota should be below the required bytes.',
  ],
  profileMode: 'persistent', profile, origin, status: 'running', network: {}, console: [],
};
const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
const timeout = setTimeout(() => { report.timedOut = true; void context.close(); }, 180_000);
try {
  const page = context.pages()[0] ?? await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error' && report.console.length < 100) report.console.push(message.text());
  });
  page.on('pageerror', error => { if (report.console.length < 100) report.console.push(String(error)); });
  const cdp = await context.newCDPSession(page);
  report.browser = await cdp.send('Browser.getVersion');
  await cdp.send('Network.enable', { maxTotalBufferSize: 1, maxResourceBufferSize: 1 });
  const requests = new Map();
  cdp.on('Network.requestWillBeSent', event => {
    if (/\/(packs|runtime)\//.test(new URL(event.request.url).pathname)) {
      requests.set(event.requestId, event.request.url);
      report.network[event.request.url] ??= { dataBytes: 0, encodedBytes: 0, checkpoints: [] };
    }
  });
  cdp.on('Network.dataReceived', event => {
    const url = requests.get(event.requestId);
    if (!url) return;
    const record = report.network[url];
    record.dataBytes += event.dataLength;
    record.encodedBytes += event.encodedDataLength;
    if (record.dataBytes - (record.checkpoints.at(-1)?.dataBytes ?? 0) >= 64 * 1024 * 1024) {
      const checkpoint = { at: new Date().toISOString(), dataBytes: record.dataBytes };
      record.checkpoints.push(checkpoint);
      console.log(JSON.stringify({ event: 'network-progress', url, ...checkpoint }));
    }
  });
  cdp.on('Network.loadingFinished', event => {
    const url = requests.get(event.requestId);
    if (url) Object.assign(report.network[url], { finished: true, finalEncodedBytes: event.encodedDataLength });
  });
  await page.goto(`${origin}/?diagnostics=1`);
  await page.waitForFunction(() => !!window.plantFriends);
  await page.evaluate(() => {
    window.assetStorageProbe = { puts: [], statuses: [] };
    const put = Cache.prototype.put;
    Cache.prototype.put = async function (request, response) {
      const record = {
        url: request instanceof Request ? request.url : String(request),
        expectedBytes: response.headers.get('content-length'), startedAt: new Date().toISOString(),
      };
      window.assetStorageProbe.puts.push(record);
      try {
        const result = await put.call(this, request, response);
        record.status = 'passed';
        return result;
      } catch (error) {
        record.status = 'failed';
        record.error = { name: error.name, message: error.message, stack: error.stack };
        throw error;
      } finally { record.finishedAt = new Date().toISOString(); }
    };
    const status = document.querySelector('[role=status]');
    if (status) new MutationObserver(() => {
      window.assetStorageProbe.statuses.push({ at: new Date().toISOString(), text: status.textContent });
    }).observe(status, { childList: true, characterData: true, subtree: true });
  });
  report.before = await page.evaluate(async () => ({ estimate: await navigator.storage.estimate(), persisted: await navigator.storage.persisted() }));
  report.quotaBefore = await cdp.send('Storage.getUsageAndQuota', { origin });
  console.log(JSON.stringify({ event: 'before', ...report.before, quota: report.quotaBefore }));
  report.catalogInstallation = await page.evaluate(() => window.plantFriends.install('pfaf'));
  report.afterCatalog = await page.evaluate(() => navigator.storage.estimate());
  console.log(JSON.stringify({ event: 'catalog-installed', result: report.catalogInstallation, estimate: report.afterCatalog }));
  try {
    report.modelInstallation = await page.evaluate(() => window.plantFriends.install('bioclip2'));
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = String(error);
  }
  report.after = await page.evaluate(async () => ({ estimate: await navigator.storage.estimate(), persisted: await navigator.storage.persisted(), probe: window.assetStorageProbe }));
  report.quotaAfter = await cdp.send('Storage.getUsageAndQuota', { origin });
  report.activeReceipts = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('plant-friends', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const receipts = await new Promise((resolve, reject) => {
      const transaction = db.transaction('packs', 'readonly');
      const request = transaction.objectStore('packs').getAll();
      transaction.oncomplete = () => resolve(request.result.map(pack => ({ kind: pack.manifest.kind, id: pack.manifest.id, installedAt: pack.installedAt })));
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    return receipts;
  });
} catch (error) {
  report.status = 'failed';
  report.failure = String(error);
} finally {
  clearTimeout(timeout);
  await context.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'finished', status: report.status, output, profile, failure: report.failure, modelInstallation: report.modelInstallation, after: report.after?.estimate, receipts: report.activeReceipts }));
}
if (report.status !== 'passed') process.exitCode = 1;
