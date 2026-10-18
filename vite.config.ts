import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'] },
  plugins: [react(), VitePWA({
    strategies: 'injectManifest',
    srcDir: 'src', filename: 'sw.ts',
    registerType: 'prompt',
    injectRegister: null,
    injectManifest: {
      globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      globIgnores: ['packs/**', 'runtime/**', 'fixtures/**'],
    },
    manifest: {
      name: 'Plant Friends', short_name: 'Plant Friends',
      description: 'Identify plants on your device and explore PFAF offline.',
      theme_color: '#24593c', background_color: '#f7f8f2', display: 'standalone',
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
