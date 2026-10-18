# Offline plant-ID PWA execution plan

Build a React, TypeScript, and Vite PWA that identifies one plant photo locally and opens its PFAF information offline. Use `uv`, Python 3.12, and `mypy` for asset preparation. Prove full BioCLIP 2 browser inference before building the finished interface, then complete the installation, lookup, and offline experience.

[facts.md](facts.md) is the accepted scope; [facts.meta.json](facts.meta.json) records verification choices. [research-handoff.md](research-handoff.md) preserves the supplied research. The accepted single-photo workflow and deferred work take precedence over the handoff's multi-photo and optional-model requirements. This package plans implementation; no model export, browser inference, or app replacement has been performed during goal setup.

## Evidence and decisions

- The current repository contains SwiftUI source, an Xcode project, and native tests. `plant-friends/ModelData.swift` fetches a remote Heroku JSON endpoint and expects a `common_names` array. There is no web build, Node lockfile, or Python project to extend. Replace these native targets after the browser feasibility milestone, preserving `goals/` and unrelated untracked files.
- `../pfaf-data/main.py` defines `plants`, `plant_uses`, `uses`, care/image tables, and a correlated `plant_data` view. The current schema has a singular `common_name` text field. Export directly from the base tables using a read-only connection, without importing scraper dependencies or refreshing the sibling repository.
- The inspected SQLite snapshot has **8,796 records**, **8,504 with physical descriptions**, **60,249 use associations**, and only **three non-null detail refresh timestamps**. Its SHA-256 is `4bb15be3f70a23676eea761b373a0ce8b92239ec3555b67ae2fe755ffb704ddf`; file size is 47,177,728 bytes. Compact JSON of the plant rows alone is 32,819,554 bytes. Recompute this evidence at implementation time. Empty detail fields and unknown refresh dates must survive export.
- Exact and case-folded trimmed names have no duplicate labels in this snapshot. Names include cultivars, hybrids, and parenthetical synonyms; they are catalog entries, not a verified list of distinct accepted species. Preserve them and report questionable labels without silently renaming or merging records. The source's Latin-name primary key gives identity within this snapshot, not permanent identity across botanical renaming.
- Use a small searchable index and bounded detail files rather than shipping the SQLite engine to the browser or parsing the entire detail catalog for every search. Exclude PFAF reference images from V1; the sibling README says historical image mappings need an audit.
- BioCLIP 2's [official configuration](https://huggingface.co/imageomics/bioclip-2/blob/2957b322090f9cb17ae72c71981c7218a28d81e0/open_clip_config.json) specifies 224-pixel image input, 768-dimensional shared embeddings, and shortest-side bicubic resizing. The model revision resolved during setup is `2957b322090f9cb17ae72c71981c7218a28d81e0`. Use that immutable snapshot initially and record actual exporter/runtime versions. The handoff's approximately 610 MB FP16 image-weight figure remains an estimate, not a measured export or memory requirement.
- The [official pybioclip implementation](https://github.com/Imageomics/pybioclip/blob/256e467401a57c5e2cd8acb1467fbd834d757e9d/src/bioclip/predict.py) provides the custom-label prompt reference but uses a square image-resize path. Use the pinned OpenCLIP evaluation transform as the image reference, and compare prompt vectors separately. Do not claim both image pipelines are equivalent.
- React is a straightforward fit for camera, installation, result, and browsing states; no backend or full-stack framework is needed. The local tools inspected are Node 26.3.1, npm 11.16.0, and uv 0.13.0 on arm64 macOS 26.6. Python 3.12 and Chrome are already installed. Actual WebGPU session support is still untested.

## Ordered work

### 1. Establish the web scaffold and reproducible catalog export

Create `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig*.json`, `index.html`, and a minimal `src/` app. Pin dependencies and Node requirements after checking their compatibility. Use React, Vite, ONNX Runtime Web, Vitest, Playwright, and `vite-plugin-pwa`; start with an explicit service-worker implementation rather than automatic model precaching. See the [Vite guide](https://vite.dev/guide/) and [PWA custom service-worker guide](https://vite-pwa-org.netlify.app/guide/inject-manifest).

Create `pyproject.toml`, `uv.lock`, `.python-version`, and `tools/plant_assets/` with a small CLI for catalog export, model preparation, reference checks, and fixture retrieval. Configure `mypy` for project-owned Python and narrow any untyped third-party boundary rather than globally disabling checks. Do not add forwarding helpers or a general plugin architecture.

Export `plants` plus ordered use associations and their available descriptions into an index, catalog manifest, and deterministic detail files of roughly 256 records. Preserve source fields, raw common-name text, nulls, reference markers, and refresh dates. Derive a deterministic taxon ID from the exact source key, preserving that key separately; keep display names distinct from trimmed model labels. Validate IDs, labels, ratings, UTF-8, record counts, and all references. Keep every plant record; report and resolve any model-label exclusions explicitly. Record source hash, export version, and export time separately from source freshness. Missing `source_url` stays missing; do not present a generated name-search URL as a recorded source page.

Generate catalog assets beneath `public/packs/pfaf/<catalog-id>/` and model assets beneath `public/packs/bioclip2/<pack-id>/`. Ignore generated packs, model caches, reports with large arrays, `node_modules/`, `.venv/`, and build output. Commit small schemas, manifests, numerical summaries, and required fixture attribution. Initially leave the native targets available while the feasibility page is built.

Verify with catalog tests covering the current schema, representative plants, all 292 records lacking descriptions, deterministic repeated export, duplicate input errors, source hash preservation, and zero-versus-missing ratings. Compare every exported source field and use association against the database; verify a before/after source hash. Run `uv run mypy tools/plant_assets tests/python`, `uv run pytest tests/python/test_catalog.py`, `npm run typecheck`, and `npm run build`.

### 2. Prepare the real encoder and a small reference pack

In `tools/plant_assets/model.py` and `reference.py`, download the pinned checkpoint into a reusable local cache, load its matching tokenizer/configuration, and freeze a working PyTorch/OpenCLIP/ONNX dependency set in `uv.lock`. Prepare a clearly labeled feasibility-only subset of scientific-name vectors first; build the full catalog vectors after browser feasibility succeeds.

Export the complete projected image encoder for fixed input `[1, 3, 224, 224]` and output `[1, 768]`, keeping a reproducible FP32 reference and an FP16 deployment candidate with FP32 output and normalization. Preserve all layers. Record ONNX input/output names, opset, precision, external-data mappings if present, package versions, byte counts, and SHA-256 for every file. Save the complete orientation/RGB/alpha/resize/crop/scaling/normalization policy and its hash.

Implement the pinned custom-label prompt recipe as a small documented adapter: tokenize each template plus scientific name, normalize prompt embeddings, average, and normalize again. Check a sample against the pinned official implementation. Do not reuse its probability-like display scores as app similarity. Model and text vectors must identify the same revision and prompt recipe.

Write row-major little-endian FP32 vectors with explicit row-to-taxon mapping. For all 8,796 current entries at dimension 768, the expected vector length is **27,021,312 bytes**, before any container overhead; validate the actual count rather than hardcoding this snapshot. Reload and check dimensions, finite values, unit norms, and hashes. A catalog change rebuilds text vectors while identical image weights retain the same content identity.

Verify export structure and Python-versus-FP32-ONNX outputs on identical tensors using `uv run python -m tools.plant_assets reference --pack <pack-manifest> --check-export`. Keep source/reference fixture inputs and numerical outputs reproducible; large binaries remain outside git.

### 3. Prove browser inference and establish numerical tolerances

Build a minimal developer route in `src/dev/Benchmark.tsx` plus `src/inference/{inference.worker.ts,preprocess.ts,scoring.ts,protocol.ts}` and one shared manifest validator. Import `onnxruntime-web/webgpu`, explicitly request the WebGPU provider, and self-host the matching runtime files. Check secure context, adapter creation, features/limits, session creation, and an actual model run. [ONNX Runtime's WebGPU guide](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) documents the entry point and provider selection.

Prefer a dedicated inference worker and prove that path early. If the selected browser/runtime cannot execute it in a worker, document and measure a direct asynchronous browser path before proceeding. Do not use `ort.env.wasm.proxy` for WebGPU; it is unsupported, and runtime JavaScript/WASM files must match the same build. Start with single-threaded WASM support code unless threading is needed and the required isolation headers are tested. See the [runtime configuration guide](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).

Implement reference-compatible image preprocessing rather than assuming canvas smoothing matches Pillow/OpenCLIP. Compare portrait, landscape, EXIF-oriented, transparent, and small images. Check three separate paths: Python FP32 versus FP32 ONNX on identical tensors; FP32 reference versus deployed browser FP16 on identical tensors; complete browser preprocessing plus inference versus the Python image pipeline. Fix numerical tolerances in `fixtures/numerical/tolerances.json` from this milestone, document their basis, and enforce them on additional fixtures. Record embedding agreement, score error, norm error, near-tie ranking changes, and any CPU fallback.

Save `reports/feasibility.json` and a short readable report with actual asset sizes, hardware/browser/runtime identities, initialization, first and warm inference timings, memory observations when available, and exact failures. Add `npm run test:integration -- --project=real-webgpu` against a real installed desktop Chrome. A missing GPU or failed model is a failed/incomplete required integration check, not an invisible skip or successful mock.

If the full encoder cannot run practically, preserve the benchmark and precise evidence and propose the next model/export option before substituting it. Continue independent catalog/browsing work as useful, but do not call the identification goal complete or replace it with a server implementation. Avoid large optional-model downloads; BioCLIP 2.5 is deferred.

### 4. Complete full-catalog ranking and safe request handling

Build all PFAF text vectors after the small feasibility pack passes, and identify the actual catalog count in the UI. In the inference worker, normalize the selected photo embedding in FP32 and rank all matching text vectors by cosine similarity. Break exact score ties by taxon ID. Return five candidates, raw similarities, request ID, pack/catalog identities, and timings.

Allow one `session.run` at a time. Changing the photo increments its generation, invalidates prior output, and supersedes queued requests; a running GPU operation may finish but cannot overwrite a newer selection. Reuse the model session. Keep any previous output visibly attached to its old photo, or clear it on replacement. Release image buffers, output tensors, camera tracks, and object URLs at their actual lifecycle boundaries.

Verify scoring against Python, deterministic ties, mismatched/corrupt vector rejection, one-run concurrency, reset/replacement during inference, and out-of-order completion. Use fast explicit doubles for scheduling tests and a distinct real-model test for actual output. There is no multi-photo fusion or calibration/rejection subsystem in V1; default output remains candidate-only.

### 5. Add verified installation and complete offline operation

Implement `src/assets/{manifest.ts,storage.ts,install.ts}`, `src/sw.ts`, and PWA registration. Separate the small app shell, offline PFAF text catalog, and large model download. Cache the PFAF index and all detail files as a verified catalog installation, show its readiness honestly, and keep catalog browsing independent of model readiness. Do not label lookup offline-ready while detail files are still missing.

Require an explicit model-download action displaying the manifest's actual byte total. Stream downloads with incremental SHA-256, bounded memory, progress, cancel, and retry. Begin with Cache API storage and a staging area; use OPFS or chunked assets if measured memory behavior requires it. Avoid response clones/stream tees that accumulate an entire slow branch, whole-model hashing buffers, and repeated worker copies. The [large-model guidance](https://onnxruntime.ai/docs/tutorials/web/large-models.html) describes browser allocation limits, cache options, and explicit external-data handling.

Mark a pack ready only after every required file passes integrity and compatibility checks, then activate its receipt atomically, for example through an IndexedDB transaction. Retain a working pack until its replacement is verified when space permits. Any replacement requiring removal first needs an explicit choice in the app. Request persistent storage when supported, tolerate denial, detect missing/evicted files, and let the user reinstall or delete the model without deleting PFAF browsing data.

Cache every required ONNX `.wasm`/`.mjs` and worker asset from the same installed runtime build. Never rely on a CDN. Service-worker updates must preserve active pack compatibility and avoid reloading during inference; offer a controlled reload for the new shell. Validate base paths, MIME types, and cold startup using the production build rather than relying on Vite development behavior.

Verify in browser tests: cancel mid-download, mutate bytes, truncate files, change dimensions/revision, interrupt/reload, deny persistence, simulate storage failure, delete a required cache entry, update a pack, and delete/reinstall. In a fresh browser context, install the real pack, close the page, block network access, reload under the service worker, and identify a different local fixture while opening PFAF details. Test both catalog-only offline mode and full offline identification. Record attempted network requests; all required offline files must resolve locally.

### 6. Build the single-photo interface and offline PFAF views

Implement `src/features/identify/`, `src/features/catalog/`, and `src/features/settings/` with shared components only where they own actual behavior or layout. Use a clear Identify/Browse flow, readable botanical names, a large photo action, five candidate rows, and detail views that emphasize known hazards alongside edibility/use information. Keep model scores labeled similarity and explain catalog coverage without implying that a predicted plant is safe to consume. Put runtime internals in a developer panel.

Support a live camera preview with a still-capture button and an upload alternative. Request permission only after a camera action; stop tracks on exit/reset. Enforce and document initial limits of 20 MiB encoded file size and 24 megapixels before retaining large decoded images; adjust these if measured desktop memory requires stricter limits. Check dimensions before full decode where possible. Give useful format/size errors, including for unsupported HEIC, instead of hanging or silently converting through a service.

Search scientific and common names from the local index, render source prose as text, preserve reference markers and supplied disclaimers, distinguish zero ratings from missing ratings, and show unknown source freshness honestly. Keep the photo in memory for the session only. No saved photos, analytics, remote fonts, external identification APIs, or automatic external image requests.

Verify camera capture with a test video stream, permission denial/no-device states, JPEG/PNG/WebP uploads, malformed images, limits, replacement/reset, model readiness, missing PFAF text, and browse without WebGPU. Inspect network requests for photo bytes or metadata. Manually review keyboard navigation, accessible labels, desktop and narrow viewport layouts, installability, and the clarity of candidate/coverage wording. Physical phone testing remains deferred.

### 7. Evaluate, document, and finish the repository replacement

In `tools/plant_assets/fixtures.py`, fetch a bounded, cached set of approximately 24 labeled photos from distinct iNaturalist observations covering about 12 PFAF entries, plus a small set of out-of-catalog/non-plant examples. Prefer CC0 or CC BY photos and record each photo's license, author, source URL, observation/taxon IDs, expected catalog mapping, and hash. Review mappings explicitly when modern names differ; do not invent taxonomy to force matches. Follow [iNaturalist's API practices](https://www.inaturalist.org/pages/api%2Brecommended%2Bpractices), use public read access, and throttle/cache requests. If that source is unavailable, use an equivalently documented licensed set and state the substitution. Add synthetic orientation/transparency fixtures for numerical and format checks.

Run actual browser identification on those fixtures against the full PFAF catalog. Produce per-photo top-five output and a summary of top-one/top-five results, unavailable/ambiguous labels, failures, and catalog limitations. Do not count out-of-catalog photos as positive classification cases or promise they will be rejected. This small set measures observed behavior; iNaturalist may overlap pretraining and is not an independent accuracy guarantee.

Separately benchmark cold initialization, first inference, and at least ten warm single-photo identifications with the reused session. Record median and tail timings, preprocessing/ranking time, failures, device/browser/runtime versions, and limitations of available memory instrumentation. Do not turn the handoff's phone speed target into a desktop acceptance claim. Device records must distinguish real desktop Chrome tests, automated narrow-viewport checks, and untested iPhone/Android browser/home-screen operation.

After feasibility has passed, remove the tracked Swift/Xcode source and native tests, update `README.md`, and add static-host guidance. Document model preparation/install/delete, catalog updates, local development, production preview, test suites, known failures, supported versus tested environments, and how to reproduce reports. Public hosting is guidance only; publication is deferred. Finish with fresh production offline verification and inspect the diff for unrelated deletions or generated binaries.

## Command contract

These are commands to implement and run during execution; they are not claims of existing scripts or completed checks. Keep CLI help and README examples synchronized with the final implementation.

```sh
uv sync --locked
npm ci
uv run python -m tools.plant_assets catalog --database ../pfaf-data/data.sqlite --output public/packs/pfaf
uv run python -m tools.plant_assets prepare-model --catalog <catalog-manifest> --revision 2957b322090f9cb17ae72c71981c7218a28d81e0 --output public/packs/bioclip2
uv run python -m tools.plant_assets reference --pack <model-manifest> --check-export
uv run python -m tools.plant_assets fixtures --manifest fixtures/photos.json
uv run mypy tools/plant_assets tests/python
uv run pytest tests/python
npm run typecheck
npm test
npm run build
npm run dev -- --host 127.0.0.1
npm run preview -- --host 127.0.0.1
npm run test:e2e
npm run test:integration -- --project=real-webgpu
npm run benchmark -- --iterations 10
```

The real-WebGPU integration command must serve a production build, use the actual prepared pack, and fail clearly if its required hardware/assets are absent. Ordinary fast tests can use tiny fixtures and explicit doubles. Real benchmark and integration scripts must use an actual hardware-backed browser, not software emulation presented as device performance.

## Verification coverage

Every fact marked for automated verification has a concrete planned check. Test names below are proposed files, to be consolidated when the same scenario covers several facts.

| Accepted fact | Automated evidence |
| --- | --- |
| `photo-input` | `tests/e2e/photos.spec.ts`: fake camera stream, supported uploads, replace/clear, single-photo limit |
| `photo-lifecycle` | `src/inference/*.test.ts`: one run in flight, session reuse, invalidated and late responses |
| `pfaf-import` | `tests/python/test_catalog.py`: all rows/uses round-trip, counts, deterministic export, duplicate errors, unchanged source |
| `pfaf-details` | `tests/e2e/catalog.spec.ts`: offline details including hazards/uses/ratings, missing descriptions, zero/null distinction |
| `pfaf-browse` | Same catalog suite with no model installed and no WebGPU |
| `pfaf-provenance` | Export tests and catalog UI assertions for attribution, references, timestamps, unknown freshness |
| `bioclip-feasibility` | Real-WebGPU integration plus `reports/feasibility.json`; failures remain explicit blockers |
| `asset-preparation` | `tests/python/test_model.py` and reference CLI: pinned identities, prompt parity, shapes/hashes/norms and reload |
| `candidate-ranking` | Scoring unit tests versus Python and real full-catalog top-five integration |
| `explicit-install` | `tests/e2e/install.spec.ts`: download consent/size, cancellation, retry, corruption, compatibility, activation/delete |
| `offline-identification` | `tests/integration/offline.spec.ts`: production offline reload, previously unused fixture, local runtime and PFAF files |
| `recoverable-errors` | Photo/install/catalog suites: permission/hardware/format/model/storage failures and eviction recovery |
| `photo-privacy` | `tests/e2e/privacy.spec.ts` and real integration request capture: no photo/metadata transmission or persistence, reset cleanup |
| `labeled-evaluation` | `tests/integration/evaluation.spec.ts`: pinned licensed fixture manifest and per-image results/summary |
| `numerical-regression` | Reference CLI and `tests/integration/numerics.spec.ts`: identical-tensor and complete-pipeline comparisons with fixed tolerances |
| `desktop-benchmarks` | `npm run benchmark -- --iterations 10`: environment manifest, cold/warm samples, summary and failures |
| `reproducible-delivery` | Fresh `uv sync --locked`/`npm ci`, mypy/TypeScript checks, build and preview smoke test; tracked-file scan excludes large assets |

Manual review covers `pwa-replacement`, `coverage-limits`, and `deferred-scope`, plus real desktop camera interaction and responsive layout. Automated camera emulation does not establish physical phone operation.

## Risks and completion boundary

Full BioCLIP 2 export, FP16 operators, browser memory use, and hardware-backed automation are the main unknowns. Desktop WebGPU availability alone is insufficient; the full graph must run. Exact image preprocessing is a separate source of numerical error. Diagnose these at milestone 3, before committing to interface polish or expensive full-catalog text preparation.

The catalog reflects an older, partially refreshed PFAF snapshot and includes synonyms/cultivars. Preserve its provenance, report ambiguous evaluation mappings, and avoid claiming accepted-species coverage. PFAF data/image terms are separate from the scraper code's MIT license; keep attribution and the source terms reference. This goal does not publish the dataset or resolve future public-distribution arrangements.

Completion requires the accepted facts and their selected checks, real desktop inference, real offline reload identification, reproducible reports, and a locally usable PWA. A polished shell, successful mock tests, or an unsupported-device message alone is insufficient. If external hardware/export conditions prevent the required real integration, document the exact blocker and reproduction steps and leave that requirement incomplete. Phone testing, additional models, and deferred features do not block this desktop-first goal.
