# Pixel 8a identification failure

Status: authorized Pixel 8a connected on 2026-10-18; Android 17, Chrome 155.0.8059.79. The product failure was reproduced and Android confirmed LOW_MEMORY termination. Lower-memory loader implementation is under numerical/offline verification; phone acceptance remains pending.

Mission: eliminate the redundant full-model loading buffer while preserving the model, numerical behavior and saved offline packs; verify the real phone failure and desktop regression. No quantization, score changes, cache clearing or unrelated UI redesign.

| Owner | Domain / authority | Output / stop |
| --- | --- | --- |
| Root | Sole live-phone/CDP/logcat command owner; temporary capture harness, shared ledger and integration/final gates | Preserve first failing boundary and phone evidence, compare accepted loader, publish only verified change. Root device-debugging slice is explicit because it controls the connected physical device. |
| Assets worker | `src/assets/manifest.ts`, `src/inference/inference.worker.ts`, related unit tests; in-place exclusive edit authority | Validate new optional external-data graph/JSPI manifests, load a small graph + actual Blob via public API, keep legacy Asyncify compatible; freeze files after focused checks. No weights, deployment or phone commands. |
| Python worker | `tools/plant_assets` externalization/preparation, corresponding Python tests and prepared local metadata/runtime artifacts; exclusive edit authority | Derive/verify offsets into existing unchanged ONNX, generate small graph and new immutable pack/JSPI files with same weights/cache identity; freeze generator/assets after CPU structural checks. No quantization, arithmetic edits, phone runs or release upload. |
| UI worker | `src/features/useOfflinePacks.ts`, `src/App.tsx` if priority gating needs it, related unit/browser upgrade tests; exclusive edit authority | Automatically upgrade old installed model to available compatible new pack, preserve old receipt until atomic activation and avoid overlapping model/photo preparation; freeze files after scoped checks. No worker/runtime/pack/deployment edits or phone runs. |

Decision for implementation: use ORT1.30's public JSPI entry point and external-data Blob support. A small ONNX graph will reference raw tensor offsets within the already downloaded original ONNX file. Its bytes/SHA/cache key stay unchanged. The new graph/runtime/manifest get a new pack identity. Passing only a URL or object URL to the current loader is rejected because the installed runtime still materializes and copies the entire model. Custom WASM heap injection is deferred because there is no public heap-allocation API and it would rely on internal ownership/freeing contracts.

Acceptance: reproduce current phone boundary; structural identity and desktop numerical canaries remain within existing tolerances; no model-sized ArrayBuffer for new pack weights; old manifests still work; existing verified weight chunks reused on upgrade; saved/offline automatic identification works; real phone load/inference evidence distinguishes fixed allocation path from any remaining crash. No claim of a measured zero-copy path: Blob backing is browser-managed and must be measured on-device.

## Implemented and verified before phone rollout

The implementation circles and focused integration review have completed their frozen handoffs. Current pack `8ea9a1391621f4cb429f` has a 465,117-byte graph and 58,242-byte derivation proof; its 296 initializers reference unchanged bytes inside the original 609,029,031-byte `fd3f7ee5…` ONNX file. The largest initializer payload is 8 MiB. The matching ORT1.30 JSPI runtime is self-hosted. The new path supplies external weights as a Blob and does not call `arrayBuffer()` on that file; legacy Asyncify manifests remain accepted. Automatic model upgrades retain the old receipt until new activation and use existing SHA/size chunk keys.

- All 196 Vitest tests and TypeScript passed. New worker tests explicitly reject full external-weight ArrayBuffer reads and exercise legacy loading and failure cleanup.
- All 79 Python tests passed, including 18 externalization cases; mypy passed 19 files. Every initializer's source offset, dtype, shape and bytes are verified; restored graph/tensor metadata matches the source. A tiny real CPU model has bitwise-equal outputs through the same external-data format.
- All 45 production/development browser cases passed. Two new real CacheStorage/IDB upgrade cases retain the previous model through failed and bounded-retry updates, reuse the original verified weight chunks with zero additional weight GETs, then activate the new identity without reinstall loops. Doubled inference/camera cases remain explicitly labeled.
- The complete real desktop WebGPU benchmark passed for the new JSPI pack, including ten checked reference inputs and full image pipelines, unchanged numerical tolerances, ten warm timings, 24 positive/four negative photos, actual GPU dispatch evidence, and fresh offline automatic product identification. The original expected arrays were reused only after checking their source-pack/proof/recipe provenance. Warm median 161.8 ms; positive top-one 14/24 and top-five 21/24, unchanged. Condensed evidence is [jspi-verification.json](jspi-verification.json); full local output is `.cache/pixel-desktop-benchmark.json`.
- Root and project-path builds passed. Six core archive tests and three photo archive tests passed; exact output receipts verified 49 core files (696,866,260 bytes) and all 12,350 photo files (175,461,429 bytes). Site size is 873,246,518 bytes. The prepared core release archive is 496,304,460 bytes, SHA `6eefd225439b66121d2c1cc8376d36f90e410e84b0b4058dda7d2cb0e1690b35`.
- Focused independent review found one fail-open metadata guard when both reconstruction hashes were absent; the guard now requires valid SHA-256 strings before equality. The actual prepared proof contained both valid matching hashes throughout. No threshold, preprocessing, scoring, weight-value or first-runtime photo-concurrency change was made.

Remaining acceptance: publish verified assets/code, observe the actual phone upgrading without fetching the original weight file, then retry the same user-selected image and capture renderer/GPU/exit evidence. Do not mark the phone crash fixed before this check.

Observation reported on 2026-10-18: on a Pixel 8a, identification becomes very slow, then the tab displays an error. This is a tab failure, not a reported full-browser exit. The exact Chrome/Android version, error code, last app phase and photograph are not captured yet.

Aim: find the first failing boundary on the actual device, then retain a fix only if that reproduction passes without breaking desktop/offline inference. Root owns device connection, primary-source research and evidence; interface worker performs a bounded read-only memory/concurrency audit.

## Established locally

- Current selected encoder is 609,029,031 bytes and catalog vectors are 27,021,312 bytes, from the pinned deployment receipts. The worker reads the whole model into an ArrayBuffer (`src/inference/inference.worker.ts:52`). ORT 1.30.0 then copies that external buffer using `_malloc(model.byteLength)` and `HEAPU8.set` (`node_modules/onnxruntime-web/lib/wasm/wasm-core-impl.ts:311–318,329–344`). These two model buffers alone represent about 1.22 GB decimal during copying, before graph/session/GPU allocations. This is allocation-path arithmetic, not a measured phone peak.
- The worker's photo preprocessing decodes the original image, obtains full-resolution RGBA pixels, and creates full-resolution RGB pixels before reducing to 224×224. The DOM preview is also present. Photo dimensions can therefore affect memory independently of the model.
- Compatible installed assets enable reference-photo preparation/downloading independently of runtime initialization. This work can overlap a first identification. Saved photo files are not all decoded images resident in memory; their download size is not an estimate of RAM.
- Automatic identification shares one load per engine/pack, and the worker serializes inference. The audit has not found evidence that a normal initial upload launches duplicate model sessions.
- Android/phone success was not established by the desktop benchmark or simulated-worker UI checks.
- The authorized device is connected. Only the Plant Friends target is inspected; other Chrome tabs are preserved. Device serials, user photo bytes and unrelated application logs are excluded from published evidence.

## On-device baseline

- Saved public pack `e2b03528fe84908219e7`, native Asyncify: diagnostics model load alone succeeded in 17,466.9 ms, with ARM/Valhall hardware WebGPU and shader-f16. Five-second RSS samples reached 2,233,676 KiB for the renderer. RSS snapshots are not measured peaks or exclusive GPU memory.
- The first pinned prepared reference tensor succeeded: 5.9 ms preprocessing, 2,884.6 ms inference, 300.0 ms ranking, 3,190.5 ms total. This bypassed image decoding and shows the device can execute the model.
- Returning to the product and selecting the user's original 1080×2400 image reproduced the tab failure. The last app status was “Loading model…” with reference-photo downloads active. The renderer reached a sampled 3,004,020 KiB RSS before CDP reported `Inspector.targetCrashed`.
- `adb shell dumpsys activity exit-info com.android.chrome` matched the renderer PID and timestamp: `reason=3 (LOW_MEMORY)`, foreground importance 100, reported exit RSS 2.5 GB. This confirms Android memory-pressure termination in this reproduction; it does not attribute an exact exclusive byte count to one allocation.
- Local raw evidence: `.cache/pixel-load-baseline.json`, `.cache/pixel-tensor-baseline.json`, `.cache/pixel-product-baseline.json`, and the task-only exit record `.cache/pixel-exit-baseline.txt`. Raw logs are not published because they may include unrelated device activity.

## Competing hypotheses and probes

| Hypothesis | Confirming prediction | Disconfirming evidence / next probe |
| --- | --- | --- |
| Model initialization or first-run memory pressure | Failure occurs during loading or first execution, with an allocation failure, renderer OOM or Android low-memory termination; a tiny image can still fail | Capture CDP disconnection/crash reason, Chrome logs and relevant Android process-exit/memory evidence before asserting OOM |
| GPU/driver or unsupported runtime path | Device-lost, shader/pipeline/validation errors or a native GPU-process crash identify the failing boundary | Record Chrome version, actual adapter/features/limits and GPU crash details; do not bypass feature checks as a guessed fix |
| Full-resolution preprocessing / concurrent preparation | A 224–512px input succeeds while the original phone image fails, or inference works after reference-photo preparation is finished | Repeat with the same installed model and one small local image; compare against original input and a fully cached offline page |

Smallest intended reproduction: one saved current model/catalog, one uploaded still, one attempt with DevTools attached before upload. First distinguish the visible “Loading model…” phase from “Identifying…”. Avoid changing the model, score math, image algorithm or browser flags before collecting this boundary.

Existing same-origin `?diagnostics=1` supports staged checks without a new app release: `window.plantFriends.load()` reads installed receipts without a photo or reference-photo synchronization; after it succeeds, `identifyTensor()` can run a locally supplied pinned reference tensor, bypassing image decoding. Follow with a small image and then the original. The regular “Identifying…” label includes both preprocessing and GPU execution. Published Pages omits test fixture files, so do not assume `/fixtures/` is available there.

## Device connection

1. Pixel: Settings → About phone → Build number; tap seven times if Developer options are not enabled.
2. Settings → System → Developer options → USB debugging. Connect using a USB data cable, unlock and accept the Mac's debugging authorization prompt.
3. Mac Chrome: `chrome://inspect/#devices`, Discover USB devices, then Inspect the Plant Friends tab. Keep the original public origin so already downloaded packs remain available.
4. Use `adb devices -l` to verify authorization. Record relevant Chrome/renderer/GPU crash logs and process memory around a single reproduction; do not clear browser storage or require a model redownload.

Primary documentation checked: [Chrome remote debugging](https://developer.chrome.com/docs/devtools/remote-debugging/), [Pixel Developer options](https://developer.android.com/studio/debug/dev-options), [Android Logcat](https://developer.android.com/tools/logcat), [Android low-memory termination](https://developer.android.com/topic/performance/issues/lmk), [ORT WebGPU support](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html), and [ORT large-model restrictions](https://onnxruntime.ai/docs/tutorials/web/large-models.html).
