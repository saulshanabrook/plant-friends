import { chromium } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { platform, release, arch, tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';

const countAt = process.argv.indexOf('--iterations');
const iterations = countAt < 0 ? 10 : Number(process.argv[countAt + 1]);
const feasibilityOnly = process.argv.includes('--feasibility');
const collectNumerics = process.argv.includes('--collect-numerics');
if (!Number.isInteger(iterations) || iterations < 10) throw new Error('Record at least ten warm iterations.');
const origin = 'http://127.0.0.1:4180';
const server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4180', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let serverLog = '';
server.stdout.on('data', data => { serverLog = (serverLog + data).slice(-8000); });
server.stderr.on('data', data => { serverLog = (serverLog + data).slice(-8000); });
let browser;
let context;
let profileDirectory;
const runtimeLogs = [];
const report = { measuredAt: new Date().toISOString(), status: 'incomplete', iterations,
  scope: feasibilityOnly ? 'Full encoder feasibility with explicitly limited catalog; not final app acceptance' : 'Full PFAF catalog desktop verification',
  environment: { platform: platform(), osRelease: release(), architecture: arch(), cpu: cpus()[0]?.model, memoryBytes: totalmem(),
    node: process.version, headless: process.env.PLANT_HEADLESS === '1' },
  phoneTesting: { iPhoneSafari: 'untested', iPhoneHomeScreen: 'untested', AndroidChrome: 'untested', AndroidHomeScreen: 'untested' },
  limitations: ['Small labeled fixture sample may overlap pretraining.', 'JavaScript heap and per-process RSS snapshots do not measure peaks or exclusive GPU allocations.'], runtimeLogs };
try {
  let available = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Production preview exited: ${serverLog}`);
    try { available = (await fetch(origin)).ok; if (available) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!available) throw new Error(`Production preview did not start. Run npm run build first. ${serverLog}`);
  const fixtures = JSON.parse(await readFile('fixtures/photos.json', 'utf8'));
  // Reserve a catalog-positive photo for its first inference only after the
  // fresh offline reload. It is absent from warm runs and numerical samples.
  const offlinePhoto = fixtures.photos.filter(photo => photo.expectedTaxonId !== null).at(-1);
  if (!offlinePhoto) throw new Error('A catalog-positive offline holdout is required.');
  const reference = JSON.parse(await readFile('public/fixtures/reference/manifest.json', 'utf8'));
  const pointer = JSON.parse(await readFile('public/model.json', 'utf8'));
  const model = JSON.parse(await readFile(`public/${pointer.url}`, 'utf8'));
  if (!feasibilityOnly && model.catalog.taxonCount !== model.catalog.fullTaxonCount)
    throw new Error('Final verification requires the full catalog. Use --feasibility for an explicitly partial catalog.');
  if (reference.packId !== model.id || !reference.exportChecked) throw new Error('Regenerate checked Python references for the active model pack.');
  report.catalogCoverage = model.catalog;
  report.modelIdentity = model.model;
  report.runtimeIdentity = model.runtime;
  report.preprocessingIdentity = model.preprocessing;
  report.promptHash = model.prompts.sha256;
  const vectorPath = new URL(model.vectors.file.url, new URL(pointer.url, `file://${process.cwd()}/public/`));
  const vectorBytes = await readFile(vectorPath);
  const textVectors = new Float32Array(vectorBytes.buffer, vectorBytes.byteOffset, vectorBytes.length / 4);
  profileDirectory = await mkdtemp(join(tmpdir(), 'plant-friends-benchmark-'));
  context = await chromium.launchPersistentContext(profileDirectory, { channel: 'chrome', headless: process.env.PLANT_HEADLESS === '1' });
  browser = context.browser();
  report.environment.browserContext = 'Fresh isolated regular Chrome profile; not incognito';
  const requests = [];
  context.on('request', request => requests.push({ url: request.url(), method: request.method(), hasBody: !!request.postData() }));
  context.on('console', message => {
    if (runtimeLogs.length < 2000 && (['warning', 'error'].includes(message.type()) || /onnx|webgpu|wasm|profil|kernel|fallback/i.test(message.text())))
      runtimeLogs.push({ type: message.type(), text: message.text().slice(0, 2000) });
  });
  context.on('weberror', event => runtimeLogs.push({ type: 'pageerror', text: event.error().message }));
  let page = await context.newPage();
  await page.goto(`${origin}/?diagnostics=1`);
  await page.waitForFunction(() => !!window.plantFriends);
  report.storageBefore = await page.evaluate(() => navigator.storage.estimate());
  console.log('Installing real catalog and encoder pack in a fresh Chrome context…');
  const installStarted = performance.now();
  report.catalogInstallation = await page.evaluate(() => window.plantFriends.install('pfaf'));
  report.modelInstallation = await page.evaluate(() => window.plantFriends.install('bioclip2'));
  report.storageAfterInstall = await page.evaluate(() => navigator.storage.estimate());
  report.installationMs = performance.now() - installStarted;
  report.runtime = await page.evaluate(() => window.plantFriends.load());
  report.memoryObservation = await page.evaluate(() => {
    const memory = performance.memory;
    return memory ? { scope: 'Chrome JavaScript heap only; excludes full process/GPU memory',
      usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : { scope: 'JavaScript heap measurement unavailable' };
  });
  report.environment.browser = browser.version();
  console.log('Real model initialized:', report.runtime);
  const first = await page.evaluate(file => window.plantFriends.identifyFixture(file), fixtures.photos[0].file);
  report.firstInference = { photo: fixtures.photos[0].file, timings: first.timings, candidates: first.candidates };
  report.chromeMemoryAfterFirstInference = await chromeMemory(browser);
  const warm = [];
  for (let i = 0; i < iterations; i++) {
    const warmPhotos = fixtures.photos.filter(photo => photo !== offlinePhoto);
    const photo = warmPhotos[i % warmPhotos.length];
    const result = await page.evaluate(file => window.plantFriends.identifyFixture(file), photo.file);
    warm.push({ photo: photo.file, timings: result.timings });
    console.log(`Warm ${i + 1}/${iterations}: ${result.timings.totalMs.toFixed(1)} ms`);
  }
  const sorted = warm.map(row => row.timings.totalMs).sort((a, b) => a - b);
  report.warm = { samples: warm, medianMs: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], minimumMs: sorted[0], maximumMs: sorted.at(-1) };
  report.numerical = [];
  report.numericalFailures = [];
  const tolerances = JSON.parse(await readFile('fixtures/numerical/tolerances.json', 'utf8'));
  report.tolerances = tolerances;
  for (const sample of reference.samples) {
    const expectedBytes = await readFile(`public/fixtures/reference/${sample.embeddingUrl}`);
    const expected = new Float32Array(expectedBytes.buffer, expectedBytes.byteOffset, expectedBytes.length / 4);
    const sameTensor = await page.evaluate(async url => {
      const response = await fetch(url);
      return window.plantFriends.identifyTensor(new Float32Array(await response.arrayBuffer()));
    }, `${origin}/fixtures/reference/${sample.inputUrl}`);
    const fullPipeline = await page.evaluate(async url => {
      const response = await fetch(url);
      return window.plantFriends.identifyPhoto(await response.blob());
    }, new URL(sample.photoUrl, `${origin}/fixtures/reference/manifest.json`).href);
    const comparison = { id: sample.id, sameTensor: compare(expected, sameTensor.embedding, textVectors), fullPipeline: compare(expected, fullPipeline.embedding, textVectors),
      pythonCandidates: sample.pythonTopFive, sameTensorCandidates: sameTensor.candidates, fullPipelineCandidates: fullPipeline.candidates };
    comparison.sameTensorRankingChanged = comparison.pythonCandidates.some((candidate, i) => candidate.taxonId !== comparison.sameTensorCandidates[i]?.taxonId);
    comparison.fullPipelineRankingChanged = comparison.pythonCandidates.some((candidate, i) => candidate.taxonId !== comparison.fullPipelineCandidates[i]?.taxonId);
    report.numerical.push(comparison);
    if (comparison.sameTensor.cosine < tolerances.fp16CosineMin || comparison.sameTensor.maxError > tolerances.fp16MaxEmbeddingError ||
        comparison.sameTensor.maxScoreError > tolerances.fp16MaxScoreError || comparison.fullPipeline.maxScoreError > tolerances.pipelineMaxScoreError ||
        comparison.fullPipeline.cosine < tolerances.pipelineCosineMin || comparison.fullPipeline.maxError > tolerances.pipelineMaxEmbeddingError)
      {
        report.numericalFailures.push(sample.id);
        if (!collectNumerics) throw new Error(`Numerical agreement failed for ${sample.id}: ${JSON.stringify(comparison)}`);
      }
    if (collectNumerics) {
      await mkdir('.cache/browser-numerical', { recursive: true });
      for (const [path, embedding] of [['tensor', sameTensor.embedding], ['pipeline', fullPipeline.embedding]]) {
        const values = new Float32Array(embedding);
        await writeFile(`.cache/browser-numerical/${sample.id}.${path}.f32`, new Uint8Array(values.buffer));
      }
      console.log(`Numerical ${sample.id}: ${JSON.stringify({ tensor: comparison.sameTensor, pipeline: comparison.fullPipeline })}`);
    }
  }
  report.photoLifecycle = await page.evaluate(async files => {
    const photos = await Promise.all(files.map(async file => (await fetch(`/fixtures/photos/${file}`)).blob()));
    const [old, current] = await Promise.allSettled(photos.map(photo => window.plantFriends.identifyPhoto(photo)));
    return { oldStatus: old.status, oldError: old.status === 'rejected' ? old.reason.name : null,
      latestStatus: current.status, latestCandidateCount: current.status === 'fulfilled' ? current.value.candidates.length : 0,
      scope: 'Real worker with two immediate photo selections; superseded result must not settle current request' };
  }, fixtures.photos.slice(0, 2).map(photo => photo.file));
  if (report.photoLifecycle.oldError !== 'AbortError' || report.photoLifecycle.latestCandidateCount !== 5)
    throw new Error(`Real photo replacement failed: ${JSON.stringify(report.photoLifecycle)}`);
  const evaluation = [];
  for (const photo of feasibilityOnly ? [] : fixtures.photos.filter(photo => photo !== offlinePhoto)) {
    const result = await page.evaluate(file => window.plantFriends.identifyFixture(file), photo.file);
    const position = result.candidates.findIndex(candidate => candidate.taxonId === photo.expectedTaxonId);
    evaluation.push({ photo: photo.file, scientificName: photo.scientificName, expectedTaxonId: photo.expectedTaxonId, inCatalog: photo.expectedTaxonId !== null,
      sourceUrl: photo.sourceUrl, license: photo.license, topOne: position === 0, topFive: position >= 0, candidates: result.candidates, timings: result.timings });
  }
  report.evaluation = { count: evaluation.filter(row => row.inCatalog).length, negativeCount: evaluation.filter(row => !row.inCatalog).length,
    topOneCount: evaluation.filter(row => row.inCatalog && row.topOne).length,
    topFiveCount: evaluation.filter(row => row.inCatalog && row.topFive).length, samples: evaluation,
    scope: 'Descriptive fixture results within the installed PFAF catalog; not an accuracy guarantee.' };
  report.profilingRuntime = await page.evaluate(() => window.plantFriends.load({ diagnostics: true }));
  const profiled = await page.evaluate(async file => {
    const response = await fetch(`/fixtures/photos/${file}`);
    return window.plantFriends.profilePhoto(await response.blob());
  }, fixtures.photos[0].file);
  report.gpuProfiling = { ...profiled.gpuProfile, scope: 'Separate diagnostic run, excluded from warm timings. Counts actual WebGPU dispatch calls, not GPU timestamp durations or named ONNX operators.' };
  if (!profiled.gpuProfile?.dispatchCount) throw new Error('No real WebGPU dispatch evidence was received.');
  report.providerPlacement = runtimeLogs.filter(entry => /All nodes placed|Number of nodes|VerifyEachNodeIsAssignedToAnEp|node.*CPUExecutionProvider/i.test(entry.text));
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) throw new Error('The production page is not controlled by its service worker.');
  });
  const bytes = await readFile(`public/fixtures/photos/${offlinePhoto.file}`);
  await page.close();
  await context.setOffline(true);
  const offlineRequestsStart = requests.length;
  page = await context.newPage();
  await page.goto(`${origin}/?diagnostics=1`);
  await page.waitForFunction(() => !!window.plantFriends);
  const coldOffline = await page.evaluate(() => window.plantFriends.load());
  const offlineResult = await page.evaluate(data => window.plantFriends.identifyPhoto(new Blob([new Uint8Array(data)], { type: 'image/jpeg' })), Array.from(bytes));
  const detail = await page.evaluate(id => window.plantFriends.detail(id), offlineResult.candidates[0].taxonId);
  if (offlineResult.candidates.length !== 5 || detail.id !== offlineResult.candidates[0].taxonId) throw new Error('Real offline identification or PFAF details failed.');
  report.offline = { photo: offlinePhoto.file, firstUsedAfterOfflineReload: true,
    coldRuntime: coldOffline, timings: offlineResult.timings, candidates: offlineResult.candidates, detailId: detail.id,
    requests: requests.slice(offlineRequestsStart), result: 'Passed: fresh page, real model, offline photo and PFAF detail' };
  if (!feasibilityOnly) {
    const position = offlineResult.candidates.findIndex(candidate => candidate.taxonId === offlinePhoto.expectedTaxonId);
    evaluation.push({ photo: offlinePhoto.file, scientificName: offlinePhoto.scientificName, expectedTaxonId: offlinePhoto.expectedTaxonId, inCatalog: true,
      sourceUrl: offlinePhoto.sourceUrl, license: offlinePhoto.license, topOne: position === 0, topFive: position >= 0, candidates: offlineResult.candidates, timings: offlineResult.timings,
      scope: 'Held out until fresh offline reload' });
    report.evaluation.count = evaluation.filter(row => row.inCatalog).length;
    report.evaluation.topOneCount = evaluation.filter(row => row.inCatalog && row.topOne).length;
    report.evaluation.topFiveCount = evaluation.filter(row => row.inCatalog && row.topFive).length;
  }
  await page.close();
  page = await context.newPage();
  await page.goto(origin);
  await page.locator('input[type=file]').setInputFiles({ name: 'offline-local-plant.jpg', mimeType: 'image/jpeg', buffer: bytes });
  await page.getByRole('heading', { name: 'Possible catalog matches' }).waitFor({ timeout: 120_000 });
  if (await page.locator('.candidate-list > li').count() !== 5) throw new Error('Product UI did not render five real offline candidates.');
  await page.locator('.candidate-list button').first().click();
  await page.getByRole('heading', { name: 'Known hazards' }).waitFor();
  await mkdir('reports/screenshots', { recursive: true });
  await page.screenshot({ path: 'reports/screenshots/offline-identification.png', fullPage: true });
  report.offline.automaticIdentification = true;
  report.offline.productInterface = 'Passed: fresh offline product page, upload, automatic identification, five candidates and PFAF hazards';
  report.privacy = { requestCount: requests.length, allGetRequestsWithoutBody: requests.every(request => request.method === 'GET' && !request.hasBody),
    allRequestsLocal: requests.every(request => new URL(request.url).origin === origin) };
  if (!report.privacy.allGetRequestsWithoutBody || !report.privacy.allRequestsLocal) throw new Error('Unexpected outbound request in local inference test.');
  if (report.numericalFailures.length) throw new Error(`Numerical gates failed: ${report.numericalFailures.join(', ')}. Diagnostic collection does not waive tolerances.`);
  report.status = 'passed';
  console.log(JSON.stringify({ status: report.status, medianMs: report.warm.medianMs, p95Ms: report.warm.p95Ms,
    topOne: report.evaluation.topOneCount, topFive: report.evaluation.topFiveCount, count: report.evaluation.count, offline: report.offline.result }, null, 2));
  await context.close();
} catch (error) {
  report.status = 'failed'; report.failure = error.stack ?? String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir('reports', { recursive: true });
  await writeFile(collectNumerics ? 'reports/numerical-diagnostic.json' : feasibilityOnly ? 'reports/feasibility.json' : 'reports/desktop-benchmark.json', JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
  if (server.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}

function compare(reference, actual, textVectors) {
  if (reference.length !== actual.length || !actual.every(Number.isFinite)) throw new Error('Invalid numerical output.');
  const norm = Math.sqrt(reference.reduce((sum, value) => sum + value * value, 0));
  let dot = 0, maxError = 0;
  for (let i = 0; i < reference.length; i++) {
    const expected = reference[i] / norm;
    dot += expected * actual[i]; maxError = Math.max(maxError, Math.abs(expected - actual[i]));
  }
  let maxScoreError = 0;
  for (let row = 0; row < textVectors.length / 768; row++) {
    let delta = 0;
    for (let c = 0; c < 768; c++) delta += (reference[c] / norm - actual[c]) * textVectors[row * 768 + c];
    maxScoreError = Math.max(maxScoreError, Math.abs(delta));
  }
  const actualNorm = Math.sqrt(actual.reduce((sum, value) => sum + value * value, 0));
  return { cosine: dot, maxError, maxScoreError, normError: Math.abs(actualNorm - 1) };
}

async function chromeMemory(browser) {
  const scope = 'Single RSS snapshot of this isolated Chrome instance, not peak or exclusive GPU memory. Shared/unified allocations may appear in multiple processes; no summed total is claimed.';
  if (!browser || !['darwin', 'linux'].includes(platform())) return { scope, available: false };
  let cdp;
  try {
    cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.map(process => process.id).filter(id => Number.isSafeInteger(id) && id > 0);
    const { stdout } = await promisify(execFile)('ps', ['-o', 'pid=,rss=', '-p', ids.join(',')]);
    const rss = new Map(stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)));
    return { scope, available: true, processes: processInfo.map(process => ({ id: process.id, type: process.type,
      cpuTimeSeconds: process.cpuTime, residentBytes: rss.has(process.id) ? rss.get(process.id) * 1024 : null })) };
  } catch (error) { return { scope, available: false, reason: String(error) }; }
  finally { await cdp?.detach(); }
}
