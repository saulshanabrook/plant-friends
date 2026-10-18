# Plant Identification PWA Version One Agent Handoff

Implementation brief for a coding agent
Prepared 17 October 2026

Build a progressive web app that identifies one plant from one to three photos using the full BioCLIP 2 image encoder on the user's device. The app should work from a URL, support installation to the home screen, and identify new photos offline after its model and catalog have been downloaded. The intended catalog contains approximately 8,000 plant taxa.

The main thing is to get a real local inference path working and measured. Use Python to prepare model assets, then TypeScript and ONNX Runtime Web with WebGPU in the app. Keep the original image network for V1. Training, distillation, native app distribution, and server inference are later options.

## 1 Scope and defaults

| Decision | V1 requirement |
| --- | --- |
| Default model | Full BioCLIP 2 image encoder from imageomics/bioclip-2 |
| Optional experiment | Full BioCLIP 2.5 Huge after the BioCLIP 2 path works |
| App | TypeScript PWA with a responsive phone interface |
| Runtime | ONNX Runtime Web using WebGPU |
| Inputs | One to three still photos of the same specimen |
| Catalog | User-supplied taxa with stable IDs and scientific names |
| Output | Top five possible matches with model scores |
| Offline | Required after complete model and catalog installation |
| Privacy | Photo processing stays on the device |
| Distribution | HTTPS website and optional home screen installation |
| Rejection | Configurable experimental policy; candidate-only mode by default |

Use the existing repository and its conventions if one is supplied. Otherwise start with Vite, React, TypeScript, and a small PWA setup. Keep model preparation, inference, storage, and UI separate enough to test independently. Pin working dependencies and commit the Node and Python lockfiles.

Use the sources at the end to verify current APIs. Record the actual package versions and immutable checkpoint revision that worked. Do not substitute a different model or move inference to a server without making that change explicit to the user.

## 2 What the app must do

A person opens the app, sees the model download size, and chooses to install it. Once installation completes, they can take or select a photo, add up to two other views of the same plant, and request identification. Show the five most similar catalog entries with scientific names, available common names, and a clearly labeled match score.

The person can remove a photo, replace a photo, or start another identification. Keep the previous result visible while a new request runs, clearly indicating that the result belongs to the previous photo set. Discard stale results when an older request finishes after the user changes the inputs.

Show straightforward states for downloading, loading the model, processing photos, ready, and failure. Give actionable messages for unsupported hardware, unsupported image formats, an interrupted model download, and insufficient storage or memory. Keep technical runtime diagnostics in a separate developer panel.

V1 supports still photos. Live video, continuous scanning, segmentation of mixed vegetation, accounts, maps, social features, and plant care advice are outside this implementation.

## 3 Start with the inference feasibility check

Before building a polished interface, make a minimal page that loads the real exported image encoder and runs one actual photo through WebGPU. This is the first milestone because model size alone does not establish that a phone browser can run it.

Check a secure context, navigator.gpu, successful adapter creation, the relevant GPU features and limits, and successful session creation and inference. Test FP16 support and the exported operators. A browser exposing WebGPU is not sufficient evidence that the complete graph executes efficiently.

Record the device, OS, browser, runtime version, execution provider, actual asset size, initialization time, first inference time, and subsequent inference times. Inspect profiling or logs for CPU fallback. Individual GPU buffer limits are not a simple limit on the sum of all model weights.

If the environment has no accessible phone, build the benchmark page and complete available desktop checks. Leave phone validation explicitly pending in the final report. Never use mocked inference or a desktop benchmark as evidence of successful phone inference.

A clear unsupported-device state is acceptable for V1. Do not require a full-model WebAssembly CPU fallback if it cannot meet a usable experience, and do not silently upload a photo as a fallback. [4] [5]

## 4 Model preparation

Load BioCLIP 2 once from an immutable Hugging Face revision using a pinned OpenCLIP version. Put the model in evaluation mode and disable gradients. Use the tokenizer belonging to that same checkpoint.

Export the path corresponding to model.encode_image, including the learned projection into the shared image and text space. Export a fixed batch size of one with input shape [1, 3, 224, 224]. Return the projected embedding as FP32 and normalize it in FP32 before scoring. The heavy image network can execute in FP16 when the target runtime supports it.

BioCLIP 2 produces 768-dimensional shared embeddings. BioCLIP 2.5 Huge produces 1,024-dimensional embeddings; an optional 2.5 pack needs its own tokenizer and text vectors. Never mix vectors from one model or revision with another model's image encoder. [1] [2]

Approximate image weights alone are 610 MB for BioCLIP 2 in FP16 and 1.3 GB for BioCLIP 2.5 Huge in FP16. These are planning estimates from parameter counts, not promised ONNX download sizes or RAM requirements. Measure the export. Runtime memory also includes parsing buffers, GPU weights, and intermediate tensors.

Exporting to ONNX is preparation, not distillation. Include an FP32 reference export or a reproducible way to create one for numerical checks. Resolve unsupported operators through a documented export or graph change and verify that change against the reference. Do not remove layers to make the export load.

## 5 Pin preprocessing and text prompts

Use the OpenCLIP evaluation transform returned for the pinned model as the image reference. Serialize its full procedure: image orientation, RGB conversion, alpha compositing policy, resize dimensions and rounding, interpolation, crop, pixel scaling, channel order, mean, and standard deviation.

The official BioCLIP configuration describes shortest-side bicubic resizing. Current pybioclip code uses a different square-resize path for BioCLIP images. Choose the OpenCLIP reference and test against it; do not claim to match both. Canvas image smoothing is not automatically equivalent to the reference resize. [1] [3]

Use scientific names as the class labels. Common names, synonyms, and taxonomy are display and search metadata in V1. Do not invent missing taxonomy or add common names to only some prompts.

For text vectors, reproduce the pinned official custom-label prompt ensemble: apply its templates to each trimmed scientific name, encode and normalize each prompt, average the prompt embeddings, then normalize the average. Compare a sample against the official CustomLabelsClassifier implementation. Save the exact template strings and their hash. Implement the recipe as a documented adapter rather than depending permanently on a private helper. [3]

Keep one Python reference pipeline for image export, prompt generation, normalization, and scoring. That is the baseline for every parity test.

## 6 Catalog input and asset contract

Implement catalog import from CSV or JSON in the Python preparation tool. The browser installs prepared packs containing vectors; it cannot embed newly entered scientific names without the text encoder. Each model class must have a stable taxonId and scientificName. Optional fields are commonNames, aliases, and an external information URL. Preserve the user's identifiers. Report duplicate IDs, empty names, duplicate model labels, and ambiguous synonym mappings; do not silently rewrite the catalog.

If the actual catalog is absent, continue with a clearly labeled small demo catalog. Include the import and preparation tools needed to replace it. The UI must show the active catalog's actual name and species count. Do not invent 8,000 entries or suggest the demo has production coverage.

Store vectors as row-major FP32 with shape [N, D] and an explicit row-to-taxon mapping. For 8,000 BioCLIP 2 taxa, that is 24.576 MB. This simplifies reading through Float32Array; half-precision vectors can be a later optimization. Validate finite values, unit norms, row count, dimension, byte order, and file length after writing and reloading.

Each asset pack must contain a versioned manifest with at least these fields:

| Manifest group | Required information |
| --- | --- |
| Identity | Schema version, pack ID, model repository, immutable revision |
| Export | Exporter and runtime versions, ONNX opset, precision, input and output names and shapes |
| Image preparation | Complete preprocessing policy and policy hash |
| Text preparation | Tokenizer identity, exact prompt templates, normalization policy, prompt hash |
| Catalog | Catalog ID and hash, taxon count, ordered row mapping |
| Vectors | URL, SHA-256, byte count, dtype, dimensions, byte order |
| Model files | URL, SHA-256, byte count, and external-data mappings for every required file |
| Scoring | Mean-per-view cosine policy and schema version |
| Rejection | Disabled by default, or explicit thresholds with policy version and validation status |

Use actual measured sizes and computed hashes. Keep model, catalog, preprocessing, and prompt compatibility checks in one loader so mismatched assets fail before inference. A catalog change must rebuild its vectors but should reuse identical image weights by content hash.

## 7 Browser inference and scoring

Import ONNX Runtime Web's WebGPU entry point and request the WebGPU execution provider explicitly. Pin and self-host the matching JavaScript and WASM runtime files so offline use does not depend on a public CDN. Put inference in a dedicated worker when that path works on the target browsers. Do not use ort.env.wasm.proxy as the mechanism for offloading WebGPU; that proxy mode does not support the WebGPU provider. [4]

Allow at most one session.run operation in flight across all requests. Changing photos invalidates the current result and skips queued or remaining views; cancellation need not abort a GPU operation already running. Decode and process photos sequentially. Correct orientation once, release large decoded images after tensor preparation, and retain small thumbnails for the interface. Support JPEG, PNG, and WebP when browser decoding works. Give a useful error for other formats. Document file-size and pixel-count limits and test them.

For each photo, obtain the projected image vector and normalize it to unit length in FP32. For each catalog entry, compute the dot product with its unit text vector. The result is cosine similarity.

For multiple photos, average the unit image vectors without normalizing that average again, then compare it with each text vector. This equals averaging the per-photo cosine scores and retains disagreement between views. Preserve per-photo scores and the norm of the average for diagnostics. Process one view at a time to limit peak memory.

Start with ranking in the worker using FP32 arithmetic. Only move ranking into the ONNX graph or GPU if profiling justifies it. Apply deterministic tie-breaking by stable taxonId, return the top five, and keep raw scores for later evaluation. Do not average softmax percentages across views.

The inference result must carry request ID, model and catalog identity, input count, elapsed timings, candidate taxon IDs, combined similarity, and per-view similarity. Use explicit error types for an unavailable GPU, incompatible assets, model initialization failure, invalid image, device loss, and inference failure.

## 8 Scores and no reliable match

Display possible matches and a match score by default. A similarity score is not a calibrated probability that the species is correct. V1 must not display a percentage as a correctness probability or label a prediction confirmed.

Support a versioned optional rejection policy based on minimum top similarity and minimum margin between the first and second candidate. Keep its thresholds configurable outside the ordinary identification flow. When no validated policy is supplied, run in candidate-only mode and label the results accordingly.

When a policy rejects an input, show no reliable match and allow the person to take a clearer or different view. Do not translate that into a claim that the species is absent from the catalog. A poor view of a known species can also be rejected.

Expose raw score and margin in diagnostic exports. Calibration can follow once labeled photos of included taxa and excluded close relatives are available. Hold out entire observations or specimens, rather than splitting views of the same plant across training and evaluation. Changing the checkpoint, prompts, fusion rule, or catalog requires checking the rejection policy again.

This first version delivers local ranking and the machinery for abstention. Reliable catalog-membership detection remains a separately evaluated capability. [3]

## 9 Installation and offline storage

Separate app-shell installation from the large model download. Do not automatically precache hundreds of megabytes when someone first opens the website. Show the actual total size and require an explicit download action.

Provide progress, cancel, retry, installed status, and delete downloaded model controls. Treat storage estimates as advisory. Request persistent storage when supported, handle denial, and recover if the browser later removes assets.

Use the Cache API initially if it passes memory testing. Use OPFS or chunked assets when needed. Avoid keeping several long-lived ArrayBuffers containing the entire model, including for hashing or transfers between workers. Use a bounded-memory integrity check rather than requiring one enormous WebCrypto digest buffer.

Mark a pack ready only after all required files are complete, verified, and compatible. Make activation atomic. Keep an older working pack active until a replacement is ready when space permits. If replacement needs deleting the old pack first, explain the consequence before deletion.

After installation, the app shell, runtime, model, vectors, and catalog must all be available offline. Detect an incomplete or evicted pack and offer reinstall instead of failing with an internal exception. Large-model browser allocation limits still apply even when there is enough persistent storage. [5] [6]

## 10 Privacy and deployment

Photos and image metadata stay on the device. No analytics, telemetry, external identification service, or automatic photo upload belongs in V1. Keep images in memory for the current session and clear them when the person resets it. Revoke object URLs and release GPU and image resources as appropriate.

Host the built app and versioned assets over HTTPS. Use immutable asset URLs, correct content types, and CORS headers if assets are on a different origin. Configure and test the service worker's update behavior. Runtime and model asset paths must work both online and offline.

WebGPU is available in Safari 26 and newer and on supported Android Chrome devices, but actual support must be checked. Test ordinary browser tabs and installed home screen mode separately. ONNX Runtime Web operator support, FP16 features, and memory behavior require testing with the chosen export. [4] [7]

If WASM threading is used, configure the required cross-origin isolation headers and test the host. A single-threaded parsing or CPU support path is acceptable while inference stays on the GPU. Check the selected runtime's current configuration rules.

Provide a local development URL, a production build, and static-host deployment instructions. Public publication and native store distribution are separate from this implementation handoff.

## 11 Repository deliverables

Include an organized app, preparation tools, tests, fixtures, and documentation. Keep large model binaries out of git; store reproducible download and build information with their licenses and hashes.

Use these modules or equivalents:

| Area | Responsibility |
| --- | --- |
| App and photo UI | Installation, photo selection, results, clear error states |
| Inference worker | Session lifetime, preprocessing, sequential views, request handling |
| Catalog and scoring | Schema validation, stable ID mapping, ranking, optional rejection |
| Asset storage | Download, verification, activation, eviction recovery |
| Python tools | Catalog import, prompt vectors, image export, reference outputs |
| Diagnostics | Runtime and device information, timings, parity reports |
| Tests and fixtures | Small reproducible checks plus an explicit real-model integration path |

Provide commands for development, production build, type checking, tests, asset preparation, export verification, and serving the built app. Include a sample catalog and configuration. Model preparation must take the actual catalog and checkpoint revision as explicit inputs.

Add a README with exact setup commands, model installation instructions, asset hosting requirements, supported and tested browsers, known failures, how to replace the demo catalog, and how to reproduce benchmark results.

## 12 Verification and acceptance

Separate numerical correctness, botanical accuracy, and performance. Agreement with the Python model does not establish botanical accuracy.

### Numerical checks

Use a small licensed fixture set with portrait and landscape images, orientation metadata, transparency, and low-resolution input. Check Python FP32 against an FP32 ONNX CPU reference using identical tensors, that reference against the deployed FP16 WebGPU path using identical tensors, and the complete browser pipeline against the Python image pipeline. The FP16 deployment graph need not execute on the CPU runtime, whose supported types and kernels may differ.

Record embedding cosine agreement, maximum score error, unit norms, and rank changes. Establish and document tolerances in the feasibility milestone, then enforce them in regression tests. Investigate near-tie rank swaps rather than requiring every top-one answer to match or hiding a mismatch. All values must be finite and dimensions must match the manifest.

### Functional checks

- A fresh install shows the actual catalog size and model download size.
- Canceling or corrupting a download never leaves a pack marked ready.
- An incompatible catalog or vector file is rejected before inference.
- A real photo produces real top-five output using the actual model.
- One, two, and three views follow the defined fusion rule.
- Replacing photos during inference cannot display a stale result as current.
- A supplied rejection policy changes the outcome as specified; without it the app stays in candidate-only mode.
- Unsupported hardware, initialization failure, device loss, and missing assets produce recoverable states.
- After installation, an offline reload can identify a new local photo with no network.
- Clearing local assets removes the model and returns to the installation state.
- A network inspection confirms that photo bytes are never transmitted.

### Performance checks

Measure download and initialization separately from identification. After a warm-up, record at least ten single-photo identifications and a sequence of three-view requests. Report median and tail latency, first-run latency, ranking time, failures, and memory observations when available. Reuse the session between requests.

The provisional usability goal is a result within three seconds for a single photo after initialization on a tested recent phone. This is an engineering target to evaluate, not a claimed benchmark. If it is missed, report the measurements and bottleneck; do not silently reduce model quality.

Maintain a test matrix for desktop Chromium, iPhone Safari 26 or newer, iPhone home screen mode, Android Chrome with WebGPU, and Android home screen mode. Record exact devices and versions. An untested entry must say untested.

Use small fixtures or explicit mocks for fast UI tests and label those tests accordingly. Keep the real-model numerical check and real browser inference as distinct integration checks. A working build with phone testing pending can be delivered as experimental, with those limits stated.

## 13 Implementation order and final handoff

1. Inspect the repository, choose and pin dependencies, validate the catalog schema, and create a demo catalog if needed.
2. Prepare the real BioCLIP 2 assets and Python reference outputs.
3. Complete one actual browser WebGPU inference and numerical comparison.
4. Add scoring, multiple still views, request cancellation, and typed failure states.
5. Add model installation, integrity checks, and offline reload.
6. Build the phone interface and run functional and device checks.
7. Test BioCLIP 2.5 only if the baseline works and the extra experiment is useful.

At completion, provide the source and lockfiles, run commands, model and catalog manifests, export and parity reports, device benchmark results, and a short list of what remains untested. Distinguish real measurements from estimates and mocks. Make the smallest functioning version that exercises the complete local path.

Do not stop at a UI mockup or a notebook. If the environment blocks model export or hardware access, complete the independent work, document the precise blocker, and provide a reproducible command or benchmark page for the missing check.

## 14 Primary references

These references ground the model and runtime details. The product scope, data contracts, and provisional usability target above are implementation requirements.

1. [BioCLIP 2 model](https://huggingface.co/imageomics/bioclip-2) and [official model configuration](https://huggingface.co/imageomics/bioclip-2/blob/main/open_clip_config.json).
2. [BioCLIP 2.5 Huge model](https://huggingface.co/imageomics/bioclip-2.5-vith14) and [official model configuration](https://huggingface.co/imageomics/bioclip-2.5-vith14/blob/main/open_clip_config.json).
3. [Official pybioclip tutorial](https://imageomics.github.io/pybioclip/python-tutorial/) and [prediction implementation](https://github.com/Imageomics/pybioclip/blob/main/src/bioclip/predict.py).
4. [ONNX Runtime WebGPU guide](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) and [runtime flags and session options](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).
5. [ONNX Runtime large model guidance](https://onnxruntime.ai/docs/tutorials/web/large-models.html).
6. [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/).
7. [WebGPU in Safari 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) and [WebGPU on Android Chrome](https://developer.chrome.com/blog/new-in-webgpu-121).
