import { expect, test } from '@playwright/test';

// Production service-worker routing evidence. This does not install model data
// or establish real offline inference; the coordinator's integration suite does.
test('production worker serves a fresh query navigation offline without swallowing pack/runtime URLs', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await context.setOffline(true);
  const response = await page.goto('/?diagnostics=1');
  expect(response?.status()).toBe(200);
  expect(await response?.headerValue('content-type')).toContain('text/html');
  await expect(page.locator('#root')).not.toBeEmpty();
  const assetPage = await context.newPage();
  await expect(assetPage.goto('/packs/not-installed/missing.bin')).rejects.toThrow();
  await expect(assetPage.goto('/runtime/not-installed/missing.mjs')).rejects.toThrow();
  // The fresh context fixture disposes Chrome's offline error document too.
});
