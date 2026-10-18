/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { installedPack, readAsset } from './assets/storage';
import { handlesPhotoRequest, photoResponse } from './assets/photos';
declare const self: ServiceWorkerGlobalScope;
precacheAndRoute((self as ServiceWorkerGlobalScope & { __WB_MANIFEST: { url: string; revision: string | null }[] }).__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL(new URL('index.html', self.registration.scope).href), {
  denylist: [/\/(packs|runtime|photos)\//, /\/photos\.json$/],
}));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && event.request.cache !== 'no-store' && handlesPhotoRequest(url.href)) {
    event.respondWith(photoResponse(event.request).catch(() => Response.error()));
    return;
  }
  if (event.request.method === 'GET' && event.request.cache !== 'no-store' && url.origin === self.location.origin && /\/(packs|runtime)\//.test(url.pathname)) {
    event.respondWith((async () => {
      try {
        for (const kind of ['bioclip2', 'pfaf'] as const) {
          const pack = await installedPack(kind);
          const file = pack?.manifest.files.find(file => new URL(file.url, pack.manifestUrl).href === url.href);
          if (pack && file) return await readAsset(pack, file);
        }
      } catch { /* Online browsing can continue when local storage is blocked. */ }
      return fetch(event.request);
    })());
  }
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
