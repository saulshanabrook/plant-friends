# Plant Friends

A local, offline plant guide: choose one camera still or uploaded JPEG, PNG, or WebP, compare it with the installed PFAF catalog using BioCLIP 2, and open names, hazards, ratings, and uses. The React/TypeScript app runs inference in a dedicated WebGPU worker. Your camera and uploaded photos stay in the current browser session; the app has no inference server, telemetry, or saved photo history.

Matches are cosine similarities within the installed catalog. They are not probabilities, confirmed identifications, or evidence that a plant is safe to eat or use medicinally. Out-of-catalog plants and non-plants can still return plausible matches. PFAF search and records work without the large identification pack or a GPU.

[Similarity research](reports/similarity-research.md) compares the official Python library and demos, calibration, unknown-species detection, a saved-embedding experiment and an independent Claude Fable critique. It proposes an evaluation before adding confidence labels or cutoffs; current scoring remains unchanged. The plain PF icons are rendered by `uv run python scripts/icons.py` (use `--font` to select a local bold serif font on other platforms).

## Use the published app

Open **https://saulshanabrook.github.io/plant-friends/** on your computer or phone. Setup downloads the catalog, then the model, then all reference photos automatically, with compact progress below the photo controls. A rough time estimate covers all remaining downloads when a recent transfer rate is available; it resets after interruptions and between stages. Upload a photo or capture a camera still; identification starts automatically once the catalog and model are ready. Replacing the photo starts a new identification, and **Reset** clears the photo and results. **Add app** at the top opens the browser's install prompt when supported, or shows brief installation instructions. The HTTPS address permits browser camera access after you allow it.

Photo identification requires hardware WebGPU with `shader-f16` and enough device/browser storage and memory for the full model. Catalog browsing remains available independently. Physical phone performance is still untested; desktop Chrome is verified. Photos are processed locally, including offline after setup.

## Run locally

Use the pinned Node version in `.node-version` and Python 3.12 with [uv](https://docs.astral.sh/uv/). Keep the source database at `../pfaf-data/data.sqlite`. Preparation opens it read-only and does not run its scraper.

```sh
uv sync --locked
npm ci
node scripts/copy-runtime.mjs
uv run --locked python -m tools.plant_assets catalog --database ../pfaf-data/data.sqlite --output public/packs/pfaf
uv run --locked python -m tools.plant_assets fixtures --manifest fixtures/photos.json
```

Python is a development-time preparation tool only. It downloads the original checkpoint, exports the browser model, and prepares the catalog and label vectors. The running PWA needs no Python process or inference service: `npm run preview` serves static files, the browser saves the identification pack locally, and WebGPU runs each identification on the device. The current identification pack occupies 632.4 MiB, the text catalog 40.8 MiB, and optimized reference images 157.6 MiB plus a 9.3 MiB photo index. The text catalog transfers about 7.3 MiB from GitHub Pages with HTTP gzip compression; 40.8 MiB is its decoded saved size, not the network download. Native JSON avoids an additional Arrow/Parquet decoder for these prose records. Normal users do not run the preparation commands.

The catalog command prints its manifest path. Use it in the next command. The first preparation downloads the immutable BioCLIP 2 checkpoint and exports the complete projected image encoder; building the scientific-name vectors can take substantially longer than starting the app. Generated assets are cached and ignored by git.

```sh
uv run --locked python -m tools.plant_assets prepare-model --catalog <catalog-manifest-path> --revision 2957b322090f9cb17ae72c71981c7218a28d81e0 --output public/packs/bioclip2
uv run --locked python -m tools.plant_assets reference --pack <printed-model-manifest-path> --check-export
npm run build
npm run preview
```

Open **http://127.0.0.1:4173** in a regular window of a recent Chrome with hardware WebGPU and `shader-f16`. Catalog setup starts automatically, followed by the model. Interrupted downloads retain completed 8 MiB chunks and resume after reconnection, reopening or returning to the app. Upload a photo or capture a camera still and wait for automatic identification. Reload offline to check your setup. Private browser storage can be restricted; a regular window is recommended.

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

Interaction UI tests install the real catalog once per worker and reuse its CacheStorage/IndexedDB with a fresh page for each case. They assert that catalog payloads are not downloaded again. Installation, interruption, privacy and PWA tests retain fresh contexts where needed. Licensed photo inputs are read and SHA-checked locally, so a production preview need not publish test photos. Isolated worktrees can set `PLANT_FRIENDS_TEST_PUBLIC` to a prepared `public` directory. A bounded published-interface check is available with `node tests/manual/interface.mjs`; it holds encoder requests and does not run inference.

For an initial feasibility run, prepare with `--limit 12`, generate its checked references, build, and run `npm run benchmark -- --feasibility`. This limits only the label vectors; the full image encoder is still used. A feasibility subset does not satisfy full-catalog acceptance. Open `/?diagnostics=1` for manual installation and real inference diagnostics.

## Assets, sources, and offline behavior

- The current PFAF snapshot has 8,796 catalog records, including synonyms, hybrids, and cultivars; it is not a verified list of distinct accepted species. Only three records include a recorded detail refresh date. Export dates are displayed separately from source freshness. Missing fields remain unavailable, and zero ratings remain zero.
- Source attribution and bracketed reference markers are retained. See [the source repository](https://github.com/saulshanabrook/pfaf-data) and [PFAF's terms](https://pfaf.org/user/cmspage.aspx?pageid=136). The public app distributes text with source attribution and [licensing/provenance notices](public/third-party-notices.txt), including the historical body-text license discrepancy. All 12,370 verified source photos are included as 12,347 deduplicated WebP files, covering 6,535 plants; 2,261 plants have no verified photo. The longest edge is at most 640 pixels. Recorded credits and original source links appear in plant records. Photos download after the model; completed images survive interruption and load offline. See [photo deployment metadata](deployment/photos.json).
- BioCLIP 2 uses [the pinned checkpoint](https://huggingface.co/imageomics/bioclip-2/tree/2957b322090f9cb17ae72c71981c7218a28d81e0), its matching tokenizer/configuration, and the pinned official 80-template scientific-name ensemble. The deployment encoder stores large matrices in FP16 and casts them back to the original FP32 arithmetic; biases, normalization vectors, small constants, and input/output stay FP32. The measured encoder is 609,029,031 bytes. This precision policy passed the original numerical gates without relaxing them. See [asset preparation](tools/plant_assets/README.md) for recipes and hash rules.
- [Photo fixtures](fixtures/README.md) retain source, author, license, and hashes. The small sample may overlap pretraining. Its top-one/top-five results are descriptive checks, not a general accuracy estimate or unknown-species detector.
- The service worker saves the small app shell. Files larger than 8 MiB are saved in durable chunks using HTTP Range requests. Completed chunks survive interruption and reload, and the complete file must pass its original size/SHA-256 before activation. Legacy complete downloads remain usable. Interrupted or failed upgrades preserve the previous working pack. Persistent storage is requested but may be denied; browser data clearing or eviction requires reinstalling packs.
- The plant table reads family, synonyms and use ratings from the installed detail shards. Search, family/minimum-rating filters, column sorting and 25/50/100-row pages work offline. Missing ratings remain missing; zero stays zero.
- Browser background execution while a phone is locked is not guaranteed. The app resumes retained chunks when it can run again. See [download design and verification](reports/minimal-redesign.md) and [HTTP range guidance](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests).

ONNX Runtime Web 1.30's `/webgpu` entry is paired with the same package's self-hosted `ort-wasm-simd-threaded.asyncify.mjs` and `.wasm`. The inference worker explicitly supplies a hardware WebGPU device. JSEP runtime pairs and incompatible precision recipes are rejected. No CDN runtime is used. The separate diagnostic run counts actual GPU dispatch calls; it does not claim GPU timestamp durations. See [the precision experiment](reports/weight-storage-gpu.md) for the measured choice.

## GitHub Pages deployment

Pushes to `main` run [the Pages workflow](.github/workflows/pages.yml). The workflow downloads a SHA-256-pinned prepared asset release, verifies every selected file, builds with `VITE_BASE_PATH=/plant-friends/`, verifies the output again, and deploys through GitHub Pages. No Python process, model conversion, hosting credential, or inference server is needed in the deployment.

The generated catalog/model/runtime files stay outside git. [Deployment metadata](deployment/assets.json) selects the exact full pack and archive; [asset deployment instructions](deployment/README.md) describe preparing a new release. Only the current catalog/model/runtime and the separate SHA-256-pinned [reference photo bundle](deployment/photos.json) are published, keeping the static site below GitHub Pages' size limit. Old feasibility packs, test photographs, numerical tensors and caches are excluded. The release and website carry [data and third-party notices](public/third-party-notices.txt); attribution is available offline from the app footer.

To reproduce a project-path build locally, use `VITE_BASE_PATH=/plant-friends/ npm run build` after restoring the selected assets into a clean preparation tree. Plain `npm run build` retains the root-path local preview. The Pages manifest, start URL and service-worker scope use the project path. Public interruption/resume verification uses `node tests/manual/resumable.mjs https://saulshanabrook.github.io/plant-friends/` with the pinned local photo fixture. The [completed public check](reports/resumable-public.json) resumed the model from 16 MiB without downloading its prefix again, saved every reference photo and passed offline identification/images/table checks. A retained fully downloaded profile can finish offline-only checks by appending `--continue-offline` after the report path.

Other static hosts must serve JavaScript/WASM MIME types and retain immutable pack files during updates. Serve `sw.js`, `catalog.json`, `model.json` and `photos.json` with revalidation and publish assets before their pointers. A custom subpath requires a matching `VITE_BASE_PATH` and rebuilt site. GitHub Pages and release publication were explicitly authorized after the original local-only implementation goal.

The [full desktop verification report](reports/desktop-verification.md) records the completed 8,796-record run: median 159.25 ms warm identification, expected label first in 14/24 positive photos and in the top five in 21/24. Fresh offline identification through the app passed. These small-sample results are not a general accuracy guarantee. Real desktop camera capture and cleanup also passed after camera access was allowed; see [camera evidence](reports/camera-verification.md). Phone and home-screen environments remain untested. [Implementation state](goals/offline-plant-id-pwa/progress.md) records the completed scope.
