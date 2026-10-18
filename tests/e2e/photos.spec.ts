import { createHash } from 'node:crypto';
import { expect, test as base } from '@playwright/test';

// Product UI acceptance only. Licensed photos are real inputs; no model inference is mocked or claimed.
const test = base.extend<{ plantPhotos: { first: Buffer; second: Buffer } }>({
  plantPhotos: async ({ request }, use) => {
    const response = await request.get('/fixtures/photos.json');
    expect(response.ok(), 'Prepare the licensed photo fixtures before running UI acceptance.').toBe(true);
    const fixture = await response.json() as { photos: { file: string; sha256: string }[] };
    expect(fixture.photos.length).toBeGreaterThanOrEqual(2);
    const photos = await Promise.all(fixture.photos.slice(0, 2).map(async photo => {
      const image = await request.get(`/fixtures/photos/${encodeURIComponent(photo.file)}`);
      expect(image.ok(), `Licensed fixture ${photo.file} must be available from production preview.`).toBe(true);
      const bytes = await image.body();
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(photo.sha256);
      return bytes;
    }));
    await use({ first: photos[0], second: photos[1] });
  },
});

test('one photo can be uploaded, replaced, and reset; previous object URLs are released', async ({ page, plantPhotos }) => {
  await page.goto('/');
  const upload = page.locator('input[type=file]');
  await expect(upload).not.toHaveAttribute('multiple');
  await upload.setInputFiles({ name: 'first-plant.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.first });
  const preview = page.getByRole('img', { name: 'Selected plant to identify' });
  await expect(preview).toBeVisible();
  await expect(page.locator('.photo-label')).toContainText('first-plant.jpg');
  const firstUrl = await preview.getAttribute('src');

  await upload.setInputFiles({ name: 'replacement-plant.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.second });
  await expect(page.locator('.photo-label')).toContainText('replacement-plant.jpg');
  const secondUrl = await preview.getAttribute('src');
  expect(secondUrl).not.toBe(firstUrl);
  expect(await page.evaluate(async url => {
    try { await fetch(url!); return true; } catch { return false; }
  }, firstUrl)).toBe(false);
  await expect(page.getByRole('heading', { name: 'Possible catalog matches' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Identify this photo' })).toBeDisabled();
  expect(await page.evaluate(async url => {
    try { await fetch(url!); return true; } catch { return false; }
  }, secondUrl)).toBe(false);
});

test('malformed and oversized files show a recoverable error before a valid photo is accepted', async ({ page, plantPhotos }) => {
  await page.goto('/');
  const upload = page.locator('input[type=file]');
  await upload.setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image') });
  await expect(page.getByRole('alert')).toContainText('valid JPEG, PNG, or WebP');
  await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toHaveCount(0);

  await upload.setInputFiles({ name: 'oversized.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
  await expect(page.getByRole('alert')).toContainText('smaller than 20 MiB');
  await expect(upload).toBeEnabled();
  await upload.setInputFiles({ name: 'recovered.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.first });
  await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const failure of [
  { name: 'denied permission', code: 'NotAllowedError', message: 'Camera permission was not granted' },
  { name: 'no camera device', code: 'NotFoundError', message: 'The camera could not be opened' },
]) {
  test(`FAKE CAMERA: ${failure.name} offers upload recovery`, async ({ page, plantPhotos }) => {
    await page.addInitScript(code => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => { throw new DOMException('UI test camera failure', code); },
      });
    }, failure.code);
    await page.goto('/');
    await page.getByRole('button', { name: 'Use camera' }).click();
    await expect(page.getByRole('alert')).toContainText(failure.message);
    await expect(page.locator('video')).toHaveCount(0);
    await page.locator('input[type=file]').setInputFiles({ name: 'camera-recovery.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.first });
    await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('FAKE CAMERA: a canvas stream captures one still and releases camera tracks on capture and navigation', async ({ page }) => {
  // This is an explicit getUserMedia double for lifecycle coverage, not physical-camera evidence.
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    Object.defineProperty(window, '__uiCameraStreams', { value: streams });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 480;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#385b31'; context.fillRect(0, 0, 640, 480);
        const stream = canvas.captureStream(5);
        const timer = window.setInterval(() => {
          context.fillStyle = '#a9c17c'; context.fillRect(120, 80, 220, 300);
          if (stream.getTracks().every(track => track.readyState === 'ended')) window.clearInterval(timer);
        }, 100);
        streams.push(stream);
        return stream;
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Use camera' }).click();
  await expect(page.locator('video')).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(640);
  await page.getByRole('button', { name: 'Capture still photo' }).click();
  await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toBeVisible();
  await expect(page.locator('.photo-label')).toContainText('Camera photo · 640 × 480');
  await expect(page.locator('video')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __uiCameraStreams?: MediaStream[] }).__uiCameraStreams?.[0]?.getTracks().every(track => track.readyState === 'ended'))).toBe(true);

  await page.getByRole('button', { name: 'Use camera' }).click();
  await expect(page.locator('video')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Explore plants', exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { __uiCameraStreams?: MediaStream[] }).__uiCameraStreams?.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);

  for (const inlinePath of ['Explore the catalog →', 'Open offline setup →']) {
    await page.getByRole('button', { name: 'Identify', exact: true }).click();
    await page.getByRole('button', { name: 'Use camera', exact: true }).click();
    await expect(page.locator('video')).toBeVisible();
    await page.getByRole('button', { name: inlinePath, exact: true }).click();
    await expect(page.locator('video')).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { __uiCameraStreams?: MediaStream[] }).__uiCameraStreams?.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  }
});


test('FAKE CAMERA: resetting a stalled preview ignores its late native play rejection', async ({ page }) => {
  // A frame-less stream leaves native video.play() pending until Reset clears srcObject.
  // This exercises cancellation ordering, not a physical camera or model inference.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => new MediaStream(),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Use camera', exact: true }).click();
  await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.locator('video')).toHaveCount(0);
  await page.getByRole('button', { name: 'Explore plants', exact: true }).click();
  await page.getByRole('button', { name: 'Identify', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use camera', exact: true })).toBeEnabled();
});


test('FAKE CAMERA: canceling a pending request preserves upload and stops a late stream', async ({ page, plantPhotos }) => {
  // Explicit deferred getUserMedia double; no native camera permission or device is exercised.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () => new Promise<MediaStream>(resolve => {
        Object.defineProperty(window, '__resolvePendingCamera', {
          configurable: true,
          value: () => {
            const canvas = document.createElement('canvas');
            canvas.width = 320; canvas.height = 240;
            const stream = canvas.captureStream(1);
            Object.defineProperty(window, '__lateCameraStream', { configurable: true, value: stream });
            resolve(stream);
          },
        });
      }),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Use camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel camera', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel camera', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use camera', exact: true })).toBeEnabled();
  await expect(page.locator('input[type=file]')).toBeEnabled();

  await page.evaluate(() => (window as Window & { __resolvePendingCamera?: () => void }).__resolvePendingCamera?.());
  await expect.poll(() => page.evaluate(() => (window as Window & { __lateCameraStream?: MediaStream }).__lateCameraStream?.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('video')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.locator('input[type=file]').setInputFiles({ name: 'after-camera-cancel.jpg', mimeType: 'image/jpeg', buffer: plantPhotos.first });
  await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toBeVisible();
  await expect(page.locator('.photo-label')).toContainText('after-camera-cancel.jpg');
});
