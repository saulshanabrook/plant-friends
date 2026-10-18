import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

test('full catalog, real BioCLIP WebGPU parity, ten warm timings and fresh offline inference', async () => {
  // Missing generated assets, unavailable hardware, and numerical failures fail
  // this integration gate. Unit/UI doubles cannot satisfy it.
  const result = await promisify(execFile)(process.execPath, ['scripts/benchmark.mjs'], {
    cwd: process.cwd(), timeout: 840_000, maxBuffer: 8 * 1024 * 1024,
  });
  console.log(result.stdout);
  const report = JSON.parse(await readFile('reports/desktop-benchmark.json', 'utf8'));
  expect(report.status).toBe('passed');
  expect(report.runtime.adapter.isFallbackAdapter).toBe(false);
  expect(report.catalogCoverage.taxonCount).toBe(report.catalogCoverage.fullTaxonCount);
  expect(report.warm.samples.length).toBeGreaterThanOrEqual(10);
  expect(report.gpuProfiling.dispatchCount).toBeGreaterThan(0);
  expect(report.numerical.length).toBeGreaterThanOrEqual(10);
  expect(report.evaluation.count).toBe(24);
  expect(report.evaluation.negativeCount).toBe(4);
  expect(report.offline.candidates).toHaveLength(5);
  expect(report.privacy).toMatchObject({ allGetRequestsWithoutBody: true, allRequestsLocal: true });
});
