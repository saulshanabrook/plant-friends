import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const base = process.env.VITE_BASE_PATH ?? '/';
if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base))
  throw new Error('VITE_BASE_PATH must be / or a slash-terminated app path such as /plant-friends/.');

export default defineConfig({
  base,
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'] },
  plugins: [react(), VitePWA({
    strategies: 'injectManifest',
    srcDir: 'src', filename: 'sw.ts',
    registerType: 'prompt',
    injectRegister: null,
    injectManifest: {
      globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}', 'third-party-notices.txt'],
      globIgnores: ['packs/**', 'runtime/**', 'fixtures/**', 'photos/**'],
    },
    manifest: {
      name: 'Plant Friends', short_name: 'Plant Friends',
      id: base, start_url: base, scope: base,
      ...(base === '/plant-friends/' ? { related_applications: [{
        platform: 'webapp', url: 'manifest.webmanifest',
        id: 'https://saulshanabrook.github.io/plant-friends/',
      }] } : {}),
      description: 'Identify plants on your device and explore PFAF offline.',
      theme_color: '#ffffff', background_color: '#ffffff', display: 'standalone',
      icons: [
        { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    },
  })],
  worker: { format: 'es' },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1', port: 4173 },
});
