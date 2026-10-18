import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { channel: 'chrome', headless: false, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run preview -- --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
    { command: 'npm run dev -- --port 4174 --strictPort', url: 'http://127.0.0.1:4174', reuseExistingServer: !process.env.CI },
  ],
  projects: [
    { name: 'ui', testMatch: /(e2e\/(photos|catalog|privacy|pwa|keyboard|setup|reference-photos)|assets\/navigation)\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:4173' } },
    { name: 'assets', testMatch: /e2e\/install\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:4174' } },
    { name: 'real-webgpu', testMatch: /integration\/.*\.spec\.ts/, timeout: 900_000, use: { baseURL: 'http://127.0.0.1:4173' } },
  ],
});
