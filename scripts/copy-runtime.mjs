import { mkdir, readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const source = 'node_modules/onnxruntime-web/dist';
const version = JSON.parse(await readFile('node_modules/onnxruntime-web/package.json', 'utf8')).version;
let pointer;
try { pointer = JSON.parse(await readFile('public/model.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const model = pointer ? JSON.parse(await readFile(new URL(pointer.url, new URL('../public/model.json', import.meta.url)), 'utf8')) : null;
const variant = model?.model.externalData?.length ? 'jspi' : 'asyncify';
await mkdir(`public/runtime/${version}`, { recursive: true });
const files = [];
for (const name of await readdir(source)) {
  if (!['mjs', 'wasm'].some(ext => name === `ort-wasm-simd-threaded.${variant}.${ext}`)) continue;
  await copyFile(`${source}/${name}`, `public/runtime/${version}/${name}`);
  const bytes = await readFile(`${source}/${name}`);
  files.push({ url: `${version}/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
if (files.length !== 2) throw new Error('Expected the matching ONNX WebGPU WASM and module runtime files');
await writeFile('public/runtime/manifest.json', JSON.stringify({ version, files }));
