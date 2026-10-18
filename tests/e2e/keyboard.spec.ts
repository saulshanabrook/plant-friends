import { writeFile } from 'node:fs/promises';
import { expect, test, type Locator } from '@playwright/test';
import type { CatalogEntry, CatalogManifest, ModelManifest } from '../../src/assets/manifest';

test('real Chrome keyboard navigation, native upload focus, automatic setup, and catalog dialog preserve focus', async ({ page, request }, testInfo) => {
  // Automated desktop keyboard evidence only: no DOM focus calls, model doubles,
  // encoder download, OS-native input, screen-reader check, or phone claim.
  const trace: { action: string; focus: unknown }[] = [];
  async function press(key: string) {
    await page.keyboard.press(key);
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      const labels = element instanceof HTMLInputElement ? Array.from(element.labels ?? []).map(label => label.textContent?.trim()) : [];
      return { documentHasFocus: document.hasFocus(), tag: element?.tagName, type: element?.getAttribute('type'), name: element?.getAttribute('aria-label') || labels.join(' ') || element?.innerText?.trim().slice(0, 100), focusVisible: element?.matches(':focus-visible'), inDialog: Boolean(element?.closest('dialog')) };
    });
    trace.push({ action: key, focus });
  }
  async function tabTo(target: Locator) {
    for (let count = 0; count < 80; count++) {
      if (await target.evaluate(element => element === document.activeElement)) return;
      await press('Tab');
    }
    throw new Error(`Keyboard Tab did not reach ${target} within 80 steps.`);
  }

  try {
    const catalogPointer = await request.get('/catalog.json');
    expect(catalogPointer.ok()).toBe(true);
    const catalogResponse = await request.get((await catalogPointer.json() as { url: string }).url);
    const catalog = await catalogResponse.json() as CatalogManifest;
    const indexResponse = await request.get(new URL(catalog.indexFile, catalogResponse.url()).href);
    const index = await indexResponse.json() as CatalogEntry[];
    expect(index).toHaveLength(catalog.taxonCount);
    const plant = index[0];
    const modelPointer = await request.get('/model.json');
    expect(modelPointer.headers()['content-type']).toContain('application/json');
    const modelResponse = await request.get((await modelPointer.json() as { url: string }).url);
    const model = await modelResponse.json() as ModelManifest;
    expect(model.kind).toBe('bioclip2');
    const modelAssets = new Set(model.files.map(file => new URL(file.url, modelResponse.url()).href));
    const modelRequests: string[] = [];
    page.on('request', request => { if (modelAssets.has(request.url())) modelRequests.push(request.url()); });
    await page.goto('/?diagnostics=1');
    await page.waitForFunction(() => Boolean(window.plantFriends));
    await page.evaluate(() => window.plantFriends.install('pfaf'));
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.context().setOffline(true);
    await page.goto('/');
    const upload = page.getByLabel('Upload photo', { exact: true });
    await tabTo(upload);
    await expect(upload).toBeFocused();
    const affordance = await upload.evaluate(input => {
      const style = getComputedStyle(input);
      return { inputFocusVisible: input.matches(':focus-visible'), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(affordance.inputFocusVisible).toBe(true);
    expect(affordance.outlineStyle).not.toBe('none');
    expect(Number.parseFloat(affordance.outlineWidth)).toBeGreaterThan(0);
    const uploadScreenshot = testInfo.outputPath('keyboard-upload-focus.png');
    await page.locator('#identify').screenshot({ path: uploadScreenshot });
    await testInfo.attach('keyboard-upload-focus', { path: uploadScreenshot, contentType: 'image/png' });
    await press('Shift+Tab');
    await press('Tab');
    await expect(upload).toBeFocused();

    const search = page.getByRole('searchbox', { name: 'Search plants' });
    await tabTo(search);
    await page.keyboard.type(plant.scientificName);
    trace.push({ action: `Type scientific-name search: ${plant.scientificName}`, focus: 'labeled searchbox' });
    const opener = page.getByRole('table').getByRole('button', { name: plant.scientificName, exact: true });
    await expect(opener).toBeVisible();
    await tabTo(opener);
    await press('Enter');
    const dialog = page.getByRole('dialog', { name: plant.scientificName, exact: true });
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole('button', { name: 'Close plant details', exact: true });
    await expect(close).toBeFocused();
    await expect(dialog.getByRole('heading', { name: 'Known hazards', exact: true })).toBeVisible();
    const dialogScreenshot = testInfo.outputPath('keyboard-dialog-focus.png');
    await page.screenshot({ path: dialogScreenshot });
    await testInfo.attach('keyboard-dialog-focus', { path: dialogScreenshot, contentType: 'image/png' });
    await press('Shift+Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await press('Tab');
    await expect(close).toBeFocused();
    for (let count = 0; count < 8; count++) {
      await press('Tab');
      const focus = await dialog.evaluate(element => ({ contained: element.contains(document.activeElement), documentHasFocus: document.hasFocus(), tag: document.activeElement?.tagName }));
      // Chrome may move to browser chrome; background app controls must stay inert.
      expect(focus.contained || (!focus.documentHasFocus && focus.tag === 'BODY')).toBe(true);
    }
    await press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(modelRequests).toEqual([]);
  } finally {
    const tracePath = testInfo.outputPath('keyboard-trace.json');
    await writeFile(tracePath, JSON.stringify({ scope: 'Automated keyboard events in desktop Chrome; no OS-native, screen-reader, or phone review', actions: trace }, null, 2) + '\n');
    await testInfo.attach('keyboard-trace', { path: tracePath, contentType: 'application/json' });
  }
});
