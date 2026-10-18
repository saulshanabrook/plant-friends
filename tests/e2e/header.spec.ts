import { expect, test } from './fixtures';

// Real product/catalog UI. Installation events/API results below are explicitly
// simulated lifecycle coverage; no OS installation or model inference is claimed.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ context }) => {
  // Hold the real encoder request so the catalog is usable without downloading
  // model bytes or allowing reference-photo setup to begin.
  await context.route('**/*.onnx*', () => undefined);
});

test('compact linked header, on-demand install help and responsive plant table', async ({ page }, testInfo) => {
  await page.goto('/');
  const header = page.locator('header').first();
  await expect(header.getByRole('navigation')).toHaveCount(0);
  await expect(header).toContainText('Fully offline after download.');
  await expect(header.getByRole('link', { name: 'BioCLIP 2', exact: true })).toHaveAttribute('href', 'https://imageomics.github.io/bioclip-2/');
  await expect(header.getByRole('link', { name: 'PFAF', exact: true })).toHaveAttribute('href', 'https://pfaf.org/');
  const add = header.getByRole('button', { name: 'Add app', exact: true });
  await expect(add).toBeVisible();
  await expect(add.locator('img')).toHaveAttribute('src', '/icon.svg');
  await expect(page.locator('#install-help')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Family', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Identify this photo', exact: true })).toBeDisabled();
  await expect(page.locator('#setup-status')).toContainText('Downloading model…');
  await expect(page.locator('#setup-status')).toContainText('Estimating…');
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const path = testInfo.outputPath(`header-${viewport.width}.png`);
    await page.screenshot({ path });
    await testInfo.attach(`header-${viewport.width}`, { path, contentType: 'image/png' });
  }
  await add.click();
  await expect(page.locator('#install-help')).toContainText('Use your browser’s Install app or Add to Home Screen option.');
  await expect(add).toHaveAttribute('aria-describedby', 'install-help');
});

test('SIMULATED INSTALL: one-shot prompts require a click; dismissal permits a fresh prompt and acceptance alone does not hide Add app', async ({ page }) => {
  await page.goto('/');
  const add = page.getByRole('button', { name: 'Add app', exact: true });
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperties(event, {
      prompt: { value: async () => { throw new Error('deliberate simulated prompt rejection'); } },
      userChoice: { value: Promise.resolve({ outcome: 'dismissed' }) },
    });
    window.dispatchEvent(event);
  });
  await add.click();
  await expect(page.locator('#install-help')).toBeVisible();
  for (const outcome of ['dismissed', 'accepted'] as const) {
    await page.evaluate(outcome => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.defineProperties(event, {
        prompt: { value: async () => { document.documentElement.dataset.promptCalls = String(Number(document.documentElement.dataset.promptCalls ?? 0) + 1); } },
        userChoice: { value: Promise.resolve({ outcome }) },
      });
      window.dispatchEvent(event);
    }, outcome);
    expect(await page.locator('html').getAttribute('data-prompt-calls')).toBe(outcome === 'dismissed' ? null : '1');
    await add.click();
    await expect(page.locator('html')).toHaveAttribute('data-prompt-calls', outcome === 'dismissed' ? '1' : '2');
    await expect(add).toBeVisible();
    await expect(page.locator('#install-help')).toHaveCount(0);
  }
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(add).toHaveCount(0);
});

test('SIMULATED INSTALL: standalone launch hides Add app', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Plant Friends', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add app', exact: true })).toHaveCount(0);
});

test('SIMULATED DISPLAY MODE: Add app returns to browser mode unless installation completed', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    const media = original('(display-mode: browser)');
    let browser = true;
    Object.defineProperty(media, 'matches', { get: () => browser });
    window.matchMedia = query => query === '(display-mode: browser)' ? media : original(query);
    Object.defineProperty(window, '__setBrowserDisplay', { value: (value: boolean) => { browser = value; media.dispatchEvent(new Event('change')); } });
  });
  await page.goto('/');
  const add = page.getByRole('button', { name: 'Add app', exact: true });
  await expect(add).toBeVisible();
  await page.evaluate(() => (window as Window & { __setBrowserDisplay?: (value: boolean) => void }).__setBrowserDisplay!(false));
  await expect(add).toHaveCount(0);
  await page.evaluate(() => (window as Window & { __setBrowserDisplay?: (value: boolean) => void }).__setBrowserDisplay!(true));
  await expect(add).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await page.evaluate(() => (window as Window & { __setBrowserDisplay?: (value: boolean) => void }).__setBrowserDisplay!(false));
  await page.evaluate(() => (window as Window & { __setBrowserDisplay?: (value: boolean) => void }).__setBrowserDisplay!(true));
  await expect(add).toHaveCount(0);
});

for (const related of [
  { name: 'ignores another app', url: '/other/manifest.webmanifest', hidden: false },
  { name: 'ignores a foreign origin with a relative ID', url: 'https://other.example/manifest.webmanifest', id: '/', hidden: false },
  { name: 'recognizes this manifest', url: '/manifest.webmanifest', hidden: true },
  { name: 'recognizes this app ID', id: '/', hidden: true },
]) {
  test(`SIMULATED INSTALL: related-app detection ${related.name}`, async ({ page }) => {
    await page.addInitScript(related => Object.defineProperty(navigator, 'getInstalledRelatedApps', { value: async () => [
      { platform: 'play', id: 'unrelated.native.app' },
      { platform: 'webapp', url: related.url, id: related.id },
    ] }), related);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Plant Friends', exact: true })).toBeVisible();
    const add = page.getByRole('button', { name: 'Add app', exact: true });
    if (related.hidden) await expect(add).toHaveCount(0);
    else await expect(add).toBeVisible();
  });
}
