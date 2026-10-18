# Plant Friends

A local, offline plant guide: choose one camera still or uploaded JPEG, PNG, or WebP, compare it with the installed PFAF catalog using BioCLIP 2, and open names, hazards, ratings, and uses. The React/TypeScript app runs inference in a dedicated WebGPU worker. Photos stay in the current browser session; the app has no inference server, telemetry, or saved photo history.

Matches are cosine similarities within the installed catalog. They are not probabilities, confirmed identifications, or evidence that a plant is safe to eat or use medicinally. Out-of-catalog plants and non-plants can still return plausible matches. PFAF search and records work without the large identification pack or a GPU.

## Run locally

Use the pinned Node version in `.node-version` and Python 3.12 with [uv](https://docs.astral.sh/uv/). Keep the source database at `../pfaf-data/data.sqlite`. Preparation opens it read-only and does not run its scraper.

```sh
uv sync --locked
npm ci
node scripts/copy-runtime.mjs
uv run --locked python -m tools.plant_assets catalog --database ../pfaf-data/data.sqlite --output public/packs/pfaf
uv run --locked python -m tools.plant_assets fixtures --manifest fixtures/photos.json
```

Python is a development-time preparation tool only. It downloads the original checkpoint, exports the browser model, and prepares the catalog and label vectors. The running PWA needs no Python process or inference service: `npm run preview` serves static files, the browser saves the identification pack locally, and WebGPU runs each identification on the device. The current browser identification download is 632.4 MiB, plus 40.8 MiB for the PFAF catalog. Normal users do not run the preparation commands.

The catalog command prints its manifest path. Use it in the next command. The first preparation downloads the immutable BioCLIP 2 checkpoint and exports the complete projected image encoder; building the scientific-name vectors can take substantially longer than starting the app. Generated assets are cached and ignored by git.

```sh
uv run --locked python -m tools.plant_assets prepare-model --catalog <catalog-manifest-path> --revision 2957b322090f9cb17ae72c71981c7218a28d81e0 --output public/packs/bioclip2
uv run --locked python -m tools.plant_assets reference --pack <printed-model-manifest-path> --check-export
npm run build
npm run preview
```

Open **http://127.0.0.1:4173** in a regular window of a recent Chrome with hardware WebGPU and `shader-f16`. In **Offline setup**, save the catalog, then explicitly consent to the measured identification-pack download. Keep the tab open until setup completes. You can cancel, retry, or delete either pack. Upload a photo or use the camera, then select **Identify this photo**. Reload offline to check your setup. The tested private browser context failed to save the large pack and cannot install the PWA; use a regular window for this workflow.

`npm run dev` starts the development server; use the production build and preview to verify service-worker/offline behavior. A browser on another device cannot access this computer's `127.0.0.1`; a phone needs a trusted HTTPS origin. The real built-in desktop camera has passed preview, capture, reset, and track-cleanup checks. Phone cameras and home-screen operation remain untested.

## Verify

```sh
uv run --locked pytest tests/python
uv run --locked mypy tools/plant_assets tests/python
npm run typecheck
npm test
npm run build
npm run test:e2e
npx playwright test --project=assets
npm run test:integration -- --project=real-webgpu
```

Fast Python/Vitest and asset/UI tests use explicitly labeled small fixtures or camera/worker doubles where needed. They do not prove model inference. The real-WebGPU integration runs the complete encoder and catalog in installed desktop Chrome, checks Python/FP32 ONNX/browser numerical agreement, records ten warm runs, evaluates the licensed fixture set, and identifies a held-out local photo after a fresh offline reload. Missing assets, unavailable hardware, or numerical failures fail that gate. The benchmark writes `reports/desktop-benchmark.json`; run it separately with `npm run benchmark -- --iterations 10` only when fresh measurements are needed.

For an initial feasibility run, prepare with `--limit 12`, generate its checked references, build, and run `npm run benchmark -- --feasibility`. This limits only the label vectors; the full image encoder is still used. A feasibility subset does not satisfy full-catalog acceptance. Open `/?diagnostics=1` for manual installation and real inference diagnostics.

## Assets, sources, and offline behavior

- The current PFAF snapshot has 8,796 catalog records, including synonyms, hybrids, and cultivars; it is not a verified list of distinct accepted species. Only three records include a recorded detail refresh date. Export dates are displayed separately from source freshness. Missing fields remain unavailable, and zero ratings remain zero.
- Source attribution and bracketed reference markers are retained. See [the source repository](https://github.com/saulshanabrook/pfaf-data) and [PFAF's terms](https://pfaf.org/user/cmspage.aspx?pageid=136). Public redistribution of source content requires its own terms review; this local project does not publish it.
- BioCLIP 2 uses [the pinned checkpoint](https://huggingface.co/imageomics/bioclip-2/tree/2957b322090f9cb17ae72c71981c7218a28d81e0), its matching tokenizer/configuration, and the pinned official 80-template scientific-name ensemble. The deployment encoder stores large matrices in FP16 and casts them back to the original FP32 arithmetic; biases, normalization vectors, small constants, and input/output stay FP32. The measured encoder is 609,029,031 bytes. This precision policy passed the original numerical gates without relaxing them. See [asset preparation](tools/plant_assets/README.md) for recipes and hash rules.
- [Photo fixtures](fixtures/README.md) retain source, author, license, and hashes. The small sample may overlap pretraining. Its top-one/top-five results are descriptive checks, not a general accuracy estimate or unknown-species detector.
- The service worker saves the small app shell. Catalog/model/runtime files are installed separately with incremental size/SHA-256 checks and semantic validation before activation. Interrupted or failed upgrades preserve the previous working pack. Persistent storage is requested but may be denied; browser data clearing or eviction requires reinstalling packs.

ONNX Runtime Web 1.30's `/webgpu` entry is paired with the same package's self-hosted `ort-wasm-simd-threaded.asyncify.mjs` and `.wasm`. The inference worker explicitly supplies a hardware WebGPU device. JSEP runtime pairs and incompatible precision recipes are rejected. No CDN runtime is used. The separate diagnostic run counts actual GPU dispatch calls; it does not claim GPU timestamp durations. See [the precision experiment](reports/weight-storage-gpu.md) for the measured choice.

## Static hosting

Serve `dist/` over HTTPS with JavaScript and WASM MIME types (`text/javascript`, `application/wasm`), including `sw.js`, the web manifest, and all generated packs/runtime files. Serve `sw.js`, `catalog.json`, and `model.json` with revalidation; retain immutable versioned assets during updates. Upload assets before their root pointers. The default build targets an origin root. Custom subpaths need a matching Vite base and a rebuilt deployment. This project provides hosting guidance only; it does not publish a site.

The [full desktop verification report](reports/desktop-verification.md) records the completed 8,796-record run: median 159.25 ms warm identification, expected label first in 14/24 positive photos and in the top five in 21/24. Fresh offline identification through the app passed. These small-sample results are not a general accuracy guarantee. Real desktop camera capture and cleanup also passed after camera access was allowed; see [camera evidence](reports/camera-verification.md). Phone and home-screen environments remain untested. [Implementation state](goals/offline-plant-id-pwa/progress.md) records the completed scope.
