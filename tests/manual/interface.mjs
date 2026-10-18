// Bounded public interface gate: real catalog, no encoder/photo body transfer.
// Usage: node tests/manual/interface.mjs [https-app-directory] [expected-bundle-path] [report.json]
import { chromium, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = process.argv[2] ?? 'https://saulshanabrook.github.io/plant-friends/';
const base = new URL(home);
if (base.protocol !== 'https:' || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('Supply an HTTPS app directory URL ending in /.');
const expected = process.argv[3] ?? null;
const report = { checkedAt: new Date().toISOString(), home, expectedBundle: expected, scope: 'Published header, plain icon, model-first priority and native Chrome installability; encoder requests held before transfer, no inference/phone/full-download claim', status: 'running' };
const profile = await mkdtemp(join(tmpdir(), 'plant-friends-interface-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
  const heldModels = [], photoRequests = [], errors = [];
  await context.route('**/*.onnx*', route => { heldModels.push(route.request().url()); });
  const page = await context.newPage();
  page.on('request', r => { if (/\/photos(?:\.json|\/)|\/__plant-friends-photo__\//.test(new URL(r.url()).pathname)) photoRequests.push(r.url()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(home + '?header-check=' + Date.now());
  report.bundle = await page.locator('script[type=module]').getAttribute('src');
  if (expected) expect(report.bundle).toBe(expected);
  const header = page.locator('header');
  await expect(header.getByRole('navigation')).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Add app', exact: true })).toBeVisible();
  await expect(header.getByRole('link', { name: 'BioCLIP 2', exact: true })).toHaveAttribute('href', 'https://imageomics.github.io/bioclip-2/');
  await expect(header.getByRole('link', { name: 'PFAF', exact: true })).toHaveAttribute('href', 'https://pfaf.org/');
  await expect(page.getByRole('button', { name: 'Identify this photo', exact: true })).toHaveCount(0);
  report.noInitialIdentifyButton = true;
  await expect(page.getByRole('searchbox', { name: 'Search plants', exact: true })).toBeVisible({ timeout: 90000 });
  await expect.poll(() => heldModels.length, { timeout: 30000 }).toBeGreaterThan(0);
  await expect(page.locator('#setup-status')).toContainText('Downloading model…');
  expect(photoRequests).toEqual([]);
  const icon = await context.request.get(home + 'icon.svg');
  expect((await icon.text()).includes('>PF</text>')).toBe(true);
  await page.evaluate(async () => { await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker was not ready after 15 seconds.')), 15_000)),
  ]); });
  const cdp = await context.newCDPSession(page);
  report.manifest = await cdp.send('Page.getAppManifest');
  report.installability = await cdp.send('Page.getInstallabilityErrors');
  expect(report.manifest.errors).toEqual([]);
  expect(report.installability.installabilityErrors).toEqual([]);
  report.browser = await cdp.send('Browser.getVersion');
  await cdp.detach();
  report.heldModelRequests = heldModels; report.photoRequestsBeforeModel = photoRequests; report.pageErrors = errors;
  expect(errors).toEqual([]);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { name: error.name, message: error.message }; }
finally {
  try { await context?.close(); } finally { await rm(profile, { recursive: true, force: true }); }
  report.profileRemoved = true;
  await writeFile(process.argv[4] ?? 'reports/header-downloads-public.json', JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, expected, error: report.error }));
process.exitCode = report.status === 'passed' ? 0 : 1;
