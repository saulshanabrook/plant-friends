# Desktop verification — full PFAF catalog

The real full-catalog automated gate passed on 2026-10-17. The app identified a previously unused local photo after a fresh offline reload, then opened its PFAF hazards through the product interface. Real built-in desktop camera preview, capture, reset and navigation cleanup passed separately after camera access was allowed. Phone and home-screen environments remain untested.

## Measured result

| Check | Result |
| --- | --- |
| Installed catalog | 8,796 source records; includes synonyms, cultivars and hybrids |
| Positive-photo expected label ranked first | 14/24 (58.3%) |
| Positive-photo expected label in top five | 21/24 (87.5%) |
| Negative/out-of-catalog examples | 4; all still receive possible matches |
| Warm single-photo total, ten runs | Median 159.25 ms; p95 162.30 ms; range 156.70–162.30 ms |
| Cold runtime initialization | 1884.7 ms after verified installation |
| First photo, including preprocessing and ranking | 224.3 ms |
| Fresh offline runtime initialization / first held-out photo | 1222.4 ms / 203.6 ms |
| Fresh local installation | 41.63 s for catalog + identification assets, including hashing/validation; local origin speed is not an internet estimate |
| Actual GPU diagnostic | 586 dispatch calls; all 875 optimized nodes placed on WebGPU; hardware adapter, no CPU fallback |
| Browser numerical cases | 10 passed, both identical-tensor and complete-image paths; no top-five ranking changes from Python in these cases |
| Privacy observation | All 146 observed requests were local GETs without bodies; no photo/metadata upload |

The 24 positive photos cover twelve catalog names and may overlap pretraining. These are descriptive results for the pinned fixture set, not a general accuracy estimate. Exact expected catalog IDs determine success; similar species and synonyms are not silently counted as correct. No rejection threshold is enabled. Neither scores nor PFAF use ratings establish identity or safety.

## Environment and assets

Measured at `2026-10-17T23:48:21.693Z` in headed Chrome `155.0.8059.80`, a fresh isolated regular profile, on Apple M4 / Metal-3, macOS 26.6 (Darwin `25.6.0`), arm64, 16 GiB RAM. Node `v26.3.1`; ONNX Runtime Web `1.30.0` native `/webgpu` with matching self-hosted asyncify files. Required feature `shader-f16` was present. The separate diagnostic instrumentation is excluded from warm timings.

- Catalog: `39831ede5fe0b995b55c`, 42,820,214 bytes of installed assets.
- Model pack: `e2b03528fe84908219e7`, 663,136,322 bytes (632.42 MiB), including encoder, vectors, row IDs, and runtime.
- Encoder: 609,029,031 bytes; SHA-256 `fd3f7ee590ea91e04bf8ef0e104fc536e28d7ff1518b7638c947da7eede733cb`.
- Vectors: shape 8,796 × 768, 27,021,312 bytes; SHA-256 `335a9fc60b3612d43d2c7b3255513515f55de108304fd7bf5a82652bd8229d01`. All finite, unique row IDs, maximum norm error 1.1921e-7.
- BioCLIP 2 revision: `2957b322090f9cb17ae72c71981c7218a28d81e0`. FP16 matrix storage with FP32 arithmetic and input/output; the checkpoint, layers, projection, and 80-template ensemble are retained.
- Source DB SHA-256: `4bb15be3f70a23676eea761b373a0ce8b92239ec3555b67ae2fe755ffb704ddf`; unchanged after read-only export and preparation.

Full vector preparation took 884.9 seconds on MPS. A strictly causal text prefix omits only verified trailing padding after every prompt’s EOT. All 560 real MPS prompt outputs and seven final vectors matched the original full-context control bitwise; this policy is bound into the vector recipe. See [preparation details](../tools/plant_assets/README.md) and [production parity evidence](../tools/plant_assets/diagnostics/text-prefix-mps-production.json).

JavaScript heap after model initialization, before first inference, was 34,735,678 bytes. The separate RSS snapshot after first inference recorded the largest renderer at 1,722,695,680 bytes and GPU process at 267,927,552 bytes. These are single per-process resident snapshots, not peaks or exclusive GPU allocation measurements; shared/unified allocations may overlap and no summed total is claimed. Raw per-process observations are in the benchmark JSON.

## Numerical agreement

All original regression thresholds were retained. Maximum cosine-score error is calculated over every one of the 8,796 candidate vectors, not only the displayed top five.

| Browser comparison to Python | Minimum cosine | Maximum normalized-coordinate error | Maximum catalog-score error |
| --- | --- | --- | --- |
| Identical input tensor | 0.999999994085 | 1.4774027e-05 | 2.0597077e-05 |
| Complete image decoding/preprocessing | 0.999999994085 | 1.4774027e-05 | 2.0597077e-05 |

Python versus the full FP32 ONNX encoder also passed all ten cases. Inputs include real photographs, portrait/landscape/small images, transparency, EXIF orientation, and lossless WebP. Detailed per-case thresholds, hashes, timings and ranking comparisons are retained in [the raw browser report](desktop-benchmark.json), [Python references](python-reference.json), and [fixed tolerance file](../fixtures/numerical/tolerances.json). Earlier all-operation FP16 arithmetic failed these limits; [the precision investigation](weight-storage-gpu.md) explains the accepted storage-only conversion.

## Per-photo evaluation

Attribution, source URLs, licenses and exact image hashes are in [the fixture manifest](../fixtures/photos.json). The final Urtica photo was first used only after the fresh offline reload. Four null-mapped negatives are excluded from the positive denominator.

| Photo | Expected label | First possible match | Expected rank ≤5 |
| --- | --- | --- | --- |
| inat-16418.jpg | Trifolium repens | Trifolium obtusiflorum (0.7106) | 2 |
| inat-96185.jpg | Trifolium repens | Trifolium repens (0.7021) | 1 |
| inat-50800.jpg | Plantago major | Plantago rugelii (0.7539) | 2 |
| inat-52808.jpg | Plantago major | Plantago rugelii (0.7425) | 3 |
| inat-22158.jpg | Bellis perennis | Bellis perennis (0.7165) | 1 |
| inat-63205.jpg | Bellis perennis | Bellis perennis (0.7220) | 1 |
| inat-28117.jpg | Alliaria petiolata | Alliaria petiolata (0.7288) | 1 |
| inat-46334.jpg | Alliaria petiolata | Alliaria petiolata (0.7264) | 1 |
| inat-13635.jpg | Achillea millefolium | Achillea millefolium (0.7212) | 1 |
| inat-16438.jpg | Achillea millefolium | Achillea millefolium (0.7116) | 1 |
| inat-15743.jpg | Sambucus nigra | Sambucus melanocarpa (0.7194) | 2 |
| inat-47315.jpg | Sambucus nigra | Sambucus latipinna (0.7397) | miss |
| inat-295979.jpg | Calendula officinalis | Calendula officinalis (0.7363) | 1 |
| inat-1183593.jpg | Calendula officinalis | Calendula officinalis (0.7330) | 1 |
| inat-9465081.jpg | Salvia officinalis | Salvia lavandulifolia (0.7214) | 4 |
| inat-21253873.jpg | Salvia officinalis | Salvia lavandulifolia (0.7328) | 3 |
| inat-50253.jpg | Rubus idaeus | Rubus sachalinensis (0.7483) | 2 |
| inat-1198216.jpg | Rubus idaeus | Rubus idaeus (0.7203) | 1 |
| inat-471845.jpg | Malus domestica | Ostrya carpinifolia (0.7432) | miss |
| inat-585657.jpg | Malus domestica | Pinus cembra (0.7070) | miss |
| inat-783569.jpg | Moringa oleifera | Moringa oleifera (0.7399) | 1 |
| inat-1766535.jpg | Moringa oleifera | Moringa oleifera (0.7522) | 1 |
| inat-105088.jpg | Urtica dioica | Urtica dioica (0.7149) | 1 |
| inat-366447886.jpg | Phalaenopsis amabilis | Cyanella orchidiformis (0.7072) | outside positive denominator |
| inat-253889943.jpg | Cattleya labiata | Dendrobium nobile (0.6828) | outside positive denominator |
| inat-23068.jpg | Turdus migratorius | Corema conradii (0.6334) | outside positive denominator |
| inat-19666.jpg | Passer domesticus | Schinus polygamus (0.6441) | outside positive denominator |
| inat-143164.jpg | Urtica dioica | Urtica dioica (0.7110) | 1 |

The two birds and two non-catalog orchids still returned five plant candidates. Their leading similarities ranged from 0.6334 to 0.7072, overlapping plausible plant matches. This demonstrates why candidate similarity is not membership detection or confidence. Three positive photos missed the top five: Sambucus nigra (`inat-47315.jpg`) and both Malus domestica examples. The report preserves these failures.

## Offline and product verification

Installed the real catalog and full identification pack with size/SHA-256 and semantic checks, then closed/reopened pages with the browser context offline. The held-out `inat-143164.jpg` was supplied as local bytes for the first time after reload; the top candidate was Urtica dioica. A separate fresh offline product page accepted an upload, required explicit Identify, showed five candidates, and opened the cached PFAF hazards. See [the final screenshot](screenshots/offline-identification.png). Source search/details were also tested offline without a model or WebGPU.

Final review repaired failed model-replacement metadata mixing, overlapping worker loads, late camera playback errors after Reset, both inline navigation paths leaving camera tracks active, pending camera requests lacking a direct cancel control, and dialog close losing keyboard focus. The [keyboard review](keyboard-verification.md) retains actual keyboard traces and manually inspected focus screenshots. Retained regressions cover those boundaries.

## Verification commands and limits

- Fresh `npm ci`: zero audit vulnerabilities; TypeScript and production build pass; 74 Vitest tests pass.
- Fresh locked `uv` environment: 55 Python tests pass; mypy checks 15 files. Five expected warnings concern the pinned legacy ONNX export API and its fixed-shape attention tracing.
- Headed desktop Chrome on the final UI build: 12 UI/PWA/navigation/keyboard/photo tests and 5 actual Cache/IDB lifecycle tests pass (17 total in 19.1 seconds). The coordinator manually inspected the retained keyboard trace and focus screenshots; see the scoped keyboard review. After the final download-copy clarification, both setup/catalog cases passed again. The explicitly required simulated permission-denied and no-camera-device recovery cases also passed (2 cases in 2.4 seconds). The full model/runtime/pack are unchanged from the real-GPU run.
- `npm run test:integration -- --project=real-webgpu`: one complete real-model test passes, exercising all full-catalog checks above; no missing-hardware skip or mock inference.
- [PWA installability evidence](pwa-installability.json): Chrome CDP reported no installability errors and valid 192/512 icons. Physical home-screen operation was not tested.
- [Real desktop camera verification](camera-verification.md): after the user allowed camera access, native Chrome received 1760 × 1328 frames, captured one still in page memory, reset/released it, and stopped all real tracks on capture/navigation. The check passed in 4.89 seconds with no saved camera image, uploads or inference. Earlier pending requests remain recorded as historical failures; their exact cause was not established. Phone cameras remain untested.
- The tested incognito context failed to store the large file. A regular-profile installation succeeded. The exact private-context failure cause is unproven; use a regular window. Storage eviction/data clearing still requires reinstalling packs.
- Phones, phone cameras, Safari, Android, and installed home-screen environments remain untested. No public deployment, additional models, accounts, saved photo history, or multi-photo behavior is included.

Run commands and local/static hosting instructions are in [README](../README.md). Generated binary packs are ignored by git; the small [full model manifest](asset-manifests/full-model.json), [catalog manifest](asset-manifests/catalog.json), and [vector validation](full-vector-validation.json) retain inspectable identities. The original source database is unchanged. No commits or pushes were made.
