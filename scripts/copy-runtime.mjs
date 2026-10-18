import { mkdir, readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const source = 'node_modules/onnxruntime-web/dist';
const version = JSON.parse(await readFile('node_modules/onnxruntime-web/package.json', 'utf8')).version;
await mkdir(`public/runtime/${version}`, { recursive: true });
const files = [];
for (const name of await readdir(source)) {
  if (!/^ort-wasm-simd-threaded\.asyncify\.(wasm|mjs)$/.test(name)) continue;
  await copyFile(`${source}/${name}`, `public/runtime/${version}/${name}`);
  const bytes = await readFile(`${source}/${name}`);
  files.push({ url: `${version}/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
if (files.length !== 2) throw new Error('Expected the matching ONNX WebGPU WASM and module runtime files');
await writeFile('public/runtime/manifest.json', JSON.stringify({ version, files }));
