# Asset preparation tools

Run commands from the repository root with the locked Python environment. The source SQLite database is read-only. Model preparation always uses the full projected BioCLIP 2 image encoder at immutable revision `2957b322090f9cb17ae72c71981c7218a28d81e0`; `--limit` changes only the scientific-name vector rows for an explicitly labeled feasibility pack. Production precision is `FP16 matrix storage with FP32 arithmetic and input/output`: finite FP32 initializers of rank at least two with at least 4,096 elements are stored in FP16, then cast to their original FP32 names before the unchanged encoder operations. Scalars, vectors, biases, normalization parameters, and smaller tensors stay FP32. The deployment recipe binds this policy separately from the FP32 export and text-vector identities, so deployment changes reuse those caches. Use the matching self-hosted native asyncify runtime from the locked Node package; actual browser numerical gates still apply.

```sh
uv sync --locked
npm ci
node scripts/copy-runtime.mjs
uv run python -m tools.plant_assets catalog --database ../pfaf-data/data.sqlite --output public/packs/pfaf
uv run python -m tools.plant_assets fixtures --manifest fixtures/photos.json
uv run python -m tools.plant_assets prepare-model --catalog public/packs/pfaf/<catalog-id>/manifest.json --revision 2957b322090f9cb17ae72c71981c7218a28d81e0 --output public/packs/bioclip2 --limit 12
uv run python -m tools.plant_assets reference --pack public/packs/bioclip2/<pack-id>/manifest.json --check-export
uv run pytest tests/python
uv run mypy tools/plant_assets tests/python
```

The `catalog` and `prepare-model` commands print the prepared manifest path. After full-encoder browser feasibility passes, prepare all catalog rows with the same storage policy:

```sh
uv run python -m tools.plant_assets prepare-model --catalog public/packs/pfaf/<catalog-id>/manifest.json --revision 2957b322090f9cb17ae72c71981c7218a28d81e0 --output public/packs/bioclip2
```

Checkpoint downloads, ONNX exports, vectors, and public packs are cached locally and remain outside git. Keep the repository working directory when running `reference`: `pack.reference.fp32Export` identifies its local recipe-specific export cache.

The runtime manifest is produced before model preparation, with versioned URLs such as `public/runtime/<onnxruntime-web-version>/<name>`. Every runtime file's actual size and hash is verified before it is listed in the model pack. Changing runtime contents/version changes the pack identity. Image exports are cached separately from text vectors; catalog rows, label text/order, prompt recipe, device, package versions, and the immutable model/configuration determine the relevant identities. Text vectors use MPS when available and CPU otherwise, with the selected device recorded; floating-point bytes may differ across devices.

The pinned OpenCLIP evaluation transform supplies shortest-side Pillow bicubic resizing, center cropping, scaling, and normalization. Before it runs, Python applies EXIF orientation once and composites alpha on opaque white. Decoded channels are interpreted as sRGB without applying embedded ICC profiles. Browser decoding must use `colorSpaceConversion: 'none'`; decoder-level differences still require real complete-pipeline comparison.

`preprocessing.sha256` hashes only the eleven policy fields, using sorted-key compact UTF-8 JSON. Exclude `sha256` and `hashSerialization` when recomputing it. Its current value is `b09f51af341c7b946e0d926d2be163141466de083009c73dcc6bbf632feb319a`. The ordered 80 prompt strings use compact JSON without sorting and hash to `1ca847c6a7b08b97797e593a6361d1a69ae81f9c7130e2bd01472e0538824139`. The templates and recipe were checked against [the pinned official pybioclip source](https://github.com/Imageomics/pybioclip/blob/256e467401a57c5e2cd8acb1467fbd834d757e9d/src/bioclip/predict.py); its file hash is recorded in `prompts.json`. Normalize each prompt embedding, average the prompts for each stripped scientific name, then normalize that mean. Stored vectors transpose the official column-major output into row-major little-endian FP32.

Text preparation retains the token prefix through the latest EOT in each complete 80-template batch and removes only verified trailing padding. The pinned model's strictly causal attention prevents those later positions from changing EOT pooling. Model/token guards require the original FP32 parameters, positional prefix, causal mask, and argmax EOT pooling; prompts and all normalization steps remain unchanged. The prefix policy is recorded in `vectorPreparation.textContext` and a new vector-cache recipe, while the image-export and matrix-storage recipes remain unchanged. Seven real scientific names, including hybrid, cultivar, and long names, passed the strict CPU diagnostic and produced bitwise-identical full-context and prefix outputs on MPS; reports and synchronized per-label timings are in `tools/plant_assets/diagnostics/text-prefix-*.json`. These sampled timings do not establish full-catalog preparation time.

Exports publish only after ONNX structure and fixed FP32 I/O shapes are checked. A complete cache receipt binds each file's recipe to its exact bytes. The public model pack is staged and renamed into place before the small `public/model.json` pointer is updated. An interrupted export can be retried; an already published pack whose bytes have been corrupted is rejected with an explicit rebuild instruction. Shared encoder filenames use their content hash, allowing full-catalog and feasibility packs to reuse identical weights.

`reference` writes ten samples: four attributed plant photographs plus portrait, landscape, small, transparent, EXIF-oriented, and lossless WebP numerical fixtures. The tenth sample is the prospective extra regression photograph `fixtures.photos[6]` (Alliaria petiolata, photo 28117), appended after the original nine. It records input/output hashes, Python top-five similarities, and optional FP32 ONNX comparison results. Its FP32 thresholds (cosine at least 0.9999 and maximum normalized-coordinate error at most 0.001) apply only to identical tensors through PyTorch versus FP32 ONNX. They are not browser FP16 or image-decoder tolerances. Real model and browser checks remain separate from the tiny explicit test doubles in the fast Python suite.

`fixtures/photos.json` pins 28 CC0 or CC BY images from distinct iNaturalist observations: the original 24 positive catalog examples, two exact-name out-of-catalog plants, and two non-plant birds. It retains author/attribution, source and license URLs, taxon IDs, mappings or explicit null mappings, dimensions, and file hashes. Retrieval uses this pinned manifest without rediscovery. `--discover` selects a new bounded positive exact-name sample only when the manifest does not exist. Only non-null `expectedTaxonId` entries belong in positive top-one/top-five totals; record null-entry possible matches separately without assuming rejection. The negative source-key absence checks preserve a database hash and do not infer synonyms. See [the fixture evaluation contract](../../fixtures/README.md). The sample may overlap model pretraining and is not an independent accuracy estimate.
