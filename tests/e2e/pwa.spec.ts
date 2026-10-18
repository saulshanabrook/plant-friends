import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext } from '@playwright/test';

interface AppManifest {
  name: string;
  short_name: string;
  display: string;
  start_url: string;
  scope: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

test('real desktop Chrome reports an installable PWA with usable root manifest and icons', async ({ playwright, baseURL }, testInfo) => {
  // Default Playwright contexts are incognito, where Chrome reports "in-incognito".
  // Use a disposable normal profile, never the user's Chrome profile. No install prompt is clicked.
  const profile = await mkdtemp(join(tmpdir(), 'plant-friends-pwa-'));
  let context: BrowserContext | undefined;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
    const page = await context.newPage();
    await page.goto(new URL('?diagnostics=1', baseURL!).href);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await context.setOffline(true);
    await page.goto(baseURL!);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveCount(1);
    const href = await manifestLink.getAttribute('href');
    expect(href).toBeTruthy();
    const manifestUrl = new URL(href!, page.url());
    expect(manifestUrl.origin).toBe(new URL(page.url()).origin);
    expect(manifestUrl.pathname).toBe('/manifest.webmanifest');
    const response = await context.request.get(manifestUrl.href);
    expect(response.ok()).toBe(true);
    const manifest = await response.json() as AppManifest;
    expect(manifest.name).toBe('Plant Friends');
    expect(manifest.short_name).toBe('Plant Friends');
    expect(manifest.display).toBe('standalone');
    expect(new URL(manifest.start_url, manifestUrl).href).toBe(new URL('/', page.url()).href);
    expect(new URL(manifest.scope, manifestUrl).href).toBe(new URL('/', page.url()).href);
    expect(manifest.icons.some(icon => icon.sizes === '192x192' && icon.type === 'image/png')).toBe(true);
    expect(manifest.icons.some(icon => icon.sizes === '512x512' && icon.type === 'image/png')).toBe(true);
    expect(manifest.icons.some(icon => icon.purpose?.split(/\s+/).includes('maskable'))).toBe(true);

    const decodedIcons: { url: string; width: number; height: number; purpose?: string }[] = [];
    for (const icon of manifest.icons) {
      const url = new URL(icon.src, manifestUrl);
      expect(url.origin).toBe(manifestUrl.origin);
      const iconResponse = await context.request.get(url.href);
      expect(iconResponse.ok(), `Declared icon must be available: ${url.href}`).toBe(true);
      expect(iconResponse.headers()['content-type']).toContain(icon.type);
      const dimensions = await page.evaluate(async url => {
        const image = new Image();
        image.src = url;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      }, url.href);
      expect(dimensions.width).toBeGreaterThan(0);
      expect(dimensions.height).toBeGreaterThan(0);
      if (icon.sizes !== 'any') expect(icon.sizes.split(/\s+/)).toContain(`${dimensions.width}x${dimensions.height}`);
      decodedIcons.push({ url: url.href, ...dimensions, purpose: icon.purpose });
    }

    const cdp = await context.newCDPSession(page);
    const browser = await cdp.send('Browser.getVersion');
    const parsedManifest = await cdp.send('Page.getAppManifest');
    const installability = await cdp.send('Page.getInstallabilityErrors');
    const serviceWorker = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
    await testInfo.attach('desktop-chrome-installability', {
      body: JSON.stringify({ browser, page: page.url(), serviceWorker, manifestUrl: manifestUrl.href, manifest, decodedIcons, manifestErrors: parsedManifest.errors, ...installability }, null, 2),
      contentType: 'application/json',
    });
    expect(parsedManifest.errors).toEqual([]);
    expect(parsedManifest.url).toBe(manifestUrl.href);
    expect(parsedManifest.data).toBeTruthy();
    expect(JSON.parse(parsedManifest.data!)).toEqual(manifest);
    expect(installability.installabilityErrors, JSON.stringify(installability.installabilityErrors)).toEqual([]);
    await cdp.detach();
  } finally {
    try { await context?.close(); }
    finally { await rm(profile, { recursive: true, force: true }); }
  }
});
