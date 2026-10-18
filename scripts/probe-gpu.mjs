// Capability evidence only: this does not establish full model execution.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, platform, release, arch } from 'node:os';
import { join } from 'node:path';

const profile = await mkdtemp(join(tmpdir(), 'plant-friends-gpu-'));
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Plant Friends GPU check</title><h1>Checking local GPU capability</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', origin,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!port) throw new Error(`Chrome did not expose a debugging port: ${stderr}`);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(target => target.type === 'page' && target.url.startsWith(origin));
  if (!target) throw new Error('The GPU probe tab did not open.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('GPU adapter check timed out.')), 20000);
    socket.onmessage = message => {
      const reply = JSON.parse(message.data);
      if (reply.id !== 1) return;
      clearTimeout(timeout);
      if (reply.error || reply.result.exceptionDetails) reject(new Error(JSON.stringify(reply)));
      else resolve(reply.result.result.value);
    };
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, awaitPromise: true, expression: `(async () => {
      const base = { secureContext: isSecureContext, userAgent: navigator.userAgent, gpuAvailable: !!navigator.gpu };
      if (!navigator.gpu) return base;
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return { ...base, adapter: null };
      return { ...base, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter },
        features: [...adapter.features], limits: { maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } };
    })()` } }));
  });
  const report = { measuredAt: new Date().toISOString(), scope: 'GPU capability probe only; full BioCLIP inference remains untested',
    environment: { platform: platform(), osRelease: release(), architecture: arch(), browser: version.Browser, javascript: version['V8-Version'] }, ...result };
  await mkdir('reports', { recursive: true });
  await writeFile('reports/gpu-capabilities.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  socket?.close();
  browser.kill('SIGTERM');
  await new Promise(resolve => browser.once('exit', resolve));
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
