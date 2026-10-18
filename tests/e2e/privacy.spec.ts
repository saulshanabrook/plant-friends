import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test('a real photo with a synthetic metadata marker stays in the session, with no outbound payload or persistent copy', async ({ page, request }) => {
  const fixtureResponse = await request.get('/fixtures/photos.json');
  expect(fixtureResponse.ok(), 'Prepare the licensed photo fixtures for UI privacy acceptance.').toBe(true);
  const fixtures = await fixtureResponse.json() as { photos: { file: string }[] };
  const imageResponse = await request.get(`/fixtures/photos/${encodeURIComponent(fixtures.photos[0].file)}`);
  expect(imageResponse.ok()).toBe(true);
  const source = await imageResponse.body();
  expect([...source.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  // Inject a valid JPEG COM segment so metadata movement is observable without any personal information.
  const marker = 'PLANT-FRIENDS-PRIVATE-UI-METADATA GPSLatitude=47.6100 GPSLongitude=-122.3300';
  const name = 'PRIVATE-SESSION-PHOTO-UI-ACCEPTANCE.jpg';
  const comment = Buffer.from(marker);
  const header = Buffer.alloc(4);
  header[0] = 0xff; header[1] = 0xfe; header.writeUInt16BE(comment.length + 2, 2);
  const privatePhoto = Buffer.concat([source.subarray(0, 2), header, comment, source.subarray(2)]);
  const requests: { url: string; method: string; hasPrivatePayload: boolean }[] = [];
  page.on('request', request => {
    const body = request.postDataBuffer();
    requests.push({ url: request.url(), method: request.method(), hasPrivatePayload: Boolean(body?.includes(comment) || body?.includes(privatePhoto)) });
  });
  await page.route('**/*.onnx*', route => route.abort('blockedbyclient'));
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'image/jpeg', buffer: privatePhoto });
  await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toBeVisible();
  await expect(page.locator('.photo-label')).toContainText(name);

  const findings = await page.evaluate(async ({ marker, name, encodedPhoto }) => {
    const findings: string[] = [];
    const visited = new WeakSet<object>();
    async function inspect(value: unknown, location: string): Promise<void> {
      if (typeof value === 'string') {
        if (value.includes(marker) || value.includes(name) || value.includes(encodedPhoto)) findings.push(location);
        return;
      }
      if (value instanceof Blob) {
        if (value.type.startsWith('image/')) findings.push(`${location}: image blob`);
        await inspect(await value.text(), location);
        return;
      }
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        await inspect(new TextDecoder().decode(bytes), location);
        return;
      }
      if (value && typeof value === 'object' && !visited.has(value)) {
        visited.add(value);
        for (const [key, item] of Object.entries(value)) {
          await inspect(key, `${location}: key`);
          await inspect(item, `${location}.${key}`);
        }
      }
    }
    for (const [label, storage] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]] as const)
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)!;
        await inspect(key, `${label} key`); await inspect(storage.getItem(key), `${label}.${key}`);
      }
    await inspect(document.cookie, 'document.cookie');
    for (const database of await indexedDB.databases()) {
      if (!database.name) continue;
      const connection = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(database.name!);
        open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
      });
      try {
        for (const store of Array.from(connection.objectStoreNames)) {
          const values = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
            const transaction = connection.transaction(store, 'readonly');
            const objectStore = transaction.objectStore(store);
            const rows = objectStore.getAll();
            const keys = objectStore.getAllKeys();
            transaction.oncomplete = () => resolve({ keys: keys.result, values: rows.result });
            transaction.onerror = () => reject(transaction.error);
          });
          await inspect(values, `IndexedDB ${database.name}.${store}`);
        }
      } finally { connection.close(); }
    }
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const savedRequest of await cache.keys()) {
        await inspect(savedRequest.url, `Cache ${cacheName} URL`);
        const response = await cache.match(savedRequest);
        if (!response) continue;
        const mime = response.headers.get('content-type') ?? '';
        if (/image\/(jpeg|webp)/i.test(mime)) findings.push(`Cache ${cacheName}: unexpected photo response`);
        await inspect(await response.text(), `Cache ${cacheName} body`);
      }
    }
    return findings;
  }, { marker, name, encodedPhoto: privatePhoto.toString('base64') });
  expect(findings).toEqual([]);

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('img', { name: 'Selected plant to identify' })).toHaveCount(0);
  const origin = new URL(page.url()).origin;
  expect(requests.filter(request => /^https?:/.test(request.url) && new URL(request.url).origin !== origin)).toEqual([]);
  expect(requests.filter(request => !['GET', 'HEAD'].includes(request.method))).toEqual([]);
  expect(requests.filter(request => request.hasPrivatePayload || request.url.includes(marker) || request.url.includes(name))).toEqual([]);
});
