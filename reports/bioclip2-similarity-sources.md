# BioCLIP 2 scores: official implementation, examples and limits

Research checked **2026-10-17 America/Los_Angeles / 2026-10-18 04:28 UTC**.
This is source research, with one small read of an existing local checkpoint;
no model execution, installation, new weights, calibration fit or product change.
Broader calibration/OOD literature belongs to the coordinator's synthesis.

## Finding

The app's number is **cosine similarity**, not a probability. Official BioCLIP 2
Python tools commonly display **temperature-scaled candidate softmax** instead.
Those numbers answer different questions. Neither the model paper nor the
reviewed official tools establishes a universal cutoff or calibrated probability
that an arbitrary PFAF suggestion is correct. Changing the display to a percent
would require an explicit score definition, candidate set and validation claim.

## Version and source boundaries

- The deployed checkpoint remains [`imageomics/bioclip-2` revision
  `2957b322090f9cb17ae72c71981c7218a28d81e0`](https://huggingface.co/imageomics/bioclip-2/tree/2957b322090f9cb17ae72c71981c7218a28d81e0).
  Its [pinned card](https://huggingface.co/imageomics/bioclip-2/blob/2957b322090f9cb17ae72c71981c7218a28d81e0/README.md)
  supports zero-shot names, few-shot classification and feature extraction;
  it warns that long-tailed training data can bias predictions toward
  well-represented species. Newer BioCLIP 2.5 releases do not change this app's
  pinned model.
- The [BioCLIP 2 paper v2](https://arxiv.org/abs/2505.23883v2) was revised
  October 23, 2025 and published at NeurIPS 2025. The official training/evaluation
  source inspected is commit
  [`49e1cf50e0341ed41d13353d23cbf963bdb1293a`](https://github.com/Imageomics/bioclip-2/tree/49e1cf50e0341ed41d13353d23cbf963bdb1293a)
  (May 20, 2026); that is current maintained source, not a claim to have reproduced
  the historical training run.
- [PyPI `pybioclip` **2.1.6**](https://pypi.org/project/pybioclip/2.1.6/),
  released August 15, 2026, is the latest version returned by the live PyPI API.
  Its publishing attestation points to
  [`256e467401a57c5e2cd8acb1467fbd834d757e9d`](https://github.com/Imageomics/pybioclip/tree/256e467401a57c5e2cd8acb1467fbd834d757e9d).
  The install distribution is `pybioclip`, import package `bioclip`, CLI `bioclip`;
  it requires Python ≥3.10. Its [dependencies](https://github.com/Imageomics/pybioclip/blob/256e467401a57c5e2cd8acb1467fbd834d757e9d/pyproject.toml#L29-L35)
  include `open_clip_torch`, `torch`, `torchvision` and `pandas`.
  [Constants](https://github.com/Imageomics/pybioclip/blob/256e467401a57c5e2cd8acb1467fbd834d757e9d/src/bioclip/_constants.py#L4-L14)
  explicitly select BioCLIP 2 and TreeOfLife-200M by default; original BioCLIP
  selects TreeOfLife-10M.

## The math and what a number means

Let `u` be the projected image embedding normalized to unit length. For each
candidate label `i`, normalize each prompt's text vector, average the 80 prompt
vectors, then normalize that average to obtain `v_i`. The official
[zero-shot evaluator](https://github.com/Imageomics/bioclip-2/blob/49e1cf50e0341ed41d13353d23cbf963bdb1293a/src/evaluation/zero_shot_iid.py#L38-L85)
uses this prompt ensemble and normalized image features. It scales their dot
products before computing top-k accuracy; softmax is unnecessary for ranking.

| Quantity | Definition | Supported interpretation |
| --- | --- | --- |
| Raw cosine | `c_i = uᵀ v_i`, mathematically in `[-1,1]` | Directional image/text alignment for this encoder, preprocessing and label recipe. It neither sums to one nor measures correctness frequency. |
| Scaled logit | `z_i = α c_i`, `α = exp(a) > 0` | A relative score; `a` is the checkpoint's learned `logit_scale`. Positive scaling preserves ordering. |
| Candidate softmax | `q_i = exp(z_i − max(z)) / Σ[j∈L] exp(z_j − max(z))` | A normalized distribution over the supplied label set `L`. It is conditional on that list and temperature, not an independently validated real-world posterior. |
| Calibrated correctness | An empirical estimate of `P(prediction correct | score/features, deployment population)` | Requires representative held-out labeled outcomes and validation. It does not follow from the first three formulas. |
| Rejection | A separate decision to abstain or say no supported match | Requires an objective and evaluated acceptance/rejection errors; argmax alone always supplies a winner. |

The official [model's `get_logits`](https://github.com/Imageomics/bioclip-2/blob/49e1cf50e0341ed41d13353d23cbf963bdb1293a/src/open_clip/model.py#L353-L361)
normalizes both modalities and uses `exp(logit_scale)` times their dot product.
The [contrastive loss](https://github.com/Imageomics/bioclip-2/blob/49e1cf50e0341ed41d13353d23cbf963bdb1293a/src/open_clip/loss.py#L104-L153)
applies image-to-text and text-to-image cross-entropy. This is discriminative
contrastive training; it does not supply a generative image likelihood
`p(image | species)` or a calibrated PFAF error model. The maintained
[training loop](https://github.com/Imageomics/bioclip-2/blob/49e1cf50e0341ed41d13353d23cbf963bdb1293a/src/training/train.py#L231-L232)
clamps the stored log scale to `[0, log(100)]`.
The [paper's training description](https://arxiv.org/html/2505.23883v2#S4)
uses taxonomic hierarchies, scientific names and common names in contrastive
supervision. Interpretation: this is not a supervised PFAF-specific class head
trained and calibrated on the deployed 8,796 entries.

**Existing pinned scalar, measured without loading a model:** the local
`.cache/checkpoint/2957b322090f9cb17ae72c71981c7218a28d81e0/open_clip_model.safetensors`
is 1,710,517,724 bytes. Reading its 51,664-byte JSON header and only four tensor
bytes found `logit_scale`, dtype F32, shape `[]`, data offsets `[6144,6148]`,
hex `8e5d9340`: `a = 4.605170249938965`; ordinary float64 `exp(a)` is
`100.00000639508755`, so the inference multiplier is approximately 100 and
temperature approximately 0.01. Float32 arithmetic can round differently.
The immutable [HF file metadata](https://huggingface.co/api/models/imageomics/bioclip-2/revision/2957b322090f9cb17ae72c71981c7218a28d81e0?blobs=true)
reports checkpoint SHA-256
`b7b2bf6fbc95799e42630e394cf95803892ab447c1a8ab629dbc82fbeaf7dfef`,
matching the prepared manifest's existing receipt. This inspection did not
rehash all 1.7 GB again. The browser encoder export returns embeddings and does
not itself apply this scalar or softmax.

### Consequences derived from the formulas

These are mathematical deductions, not new model experiments:

- With two candidates, cosine scores `0.31, 0.30` and `0.01, 0.00` both yield
  approximately `0.731, 0.269` at scale 100. Softmax alone loses absolute match
  strength because adding the same constant to all logits leaves it unchanged.
- With one candidate, its softmax is 1 for every valid image embedding. There
  is no remaining mass reserved for an unknown species or a non-plant image.
- Softmax odds obey `q_i/q_j = exp(α(c_i−c_j))`: they are relative compatibility
  weights from this discriminative model, not measured image-likelihood ratios.
- Adding candidates changes the denominator. Adding duplicate/synonymous label
  entries can split mass for one biological concept. PFAF's 8,796 entries include
  synonyms, hybrids and cultivars, so they should not silently be treated as
  8,796 disjoint, exhaustive biological species events.
- Softmax over only the displayed five results means “relative to these five”
  and inflates their shares compared with the full 8,796-label softmax. Compute
  the denominator over the declared full candidate set before truncating.
- `100 × cosine` and `(cosine + 1)/2` are cosmetic transforms, not correctness
  probabilities. A margin `c_1 − c_2` measures competition but is not an
  independently validated unknown detector.
- Summing child probabilities makes a parent's score at least as large as each
  included child's by construction. A higher genus/family percentage therefore
  does not by itself demonstrate empirical correctness at that rank.

## Actual Python behavior and runnable examples

In [the released implementation](https://github.com/Imageomics/pybioclip/blob/256e467401a57c5e2cd8acb1467fbd834d757e9d/src/bioclip/predict.py#L222-L243),
image features are normalized and `create_probabilities` applies scaled softmax.
`CustomLabelsClassifier` uses 80 templates, normalizes prompt vectors, averages
and renormalizes; `k` truncates after scoring the entire supplied list.
`TreeOfLifeClassifier` instead loads precomputed TreeOfLife label embeddings.
Higher ranks and custom bins sum their child-label probabilities. Its
[`min_prob=1e-9`](https://github.com/Imageomics/pybioclip/blob/256e467401a57c5e2cd8acb1467fbd834d757e9d/src/bioclip/predict.py#L600-L664)
filters species contributions during higher-rank aggregation; the species
top-k branch does not use it. It is **not** a universal confidence/unknown gate.

Examples adapted from the [official Python tutorial](https://imageomics.github.io/pybioclip/python-tutorial/):

```sh
pip install pybioclip==2.1.6
```

```python
from bioclip import Rank
from bioclip.predict import CustomLabelsClassifier, TreeOfLifeClassifier

# Custom candidates: closer to the app's scientific-name label construction.
custom = CustomLabelsClassifier(
    ["Abelia triflora", "Abies alba"],
    model_str="hf-hub:imageomics/bioclip-2", device="cpu")
print(custom.predict("photo.jpg", k=2))

# Separate example: the much broader precomputed TreeOfLife taxonomy.
tree = TreeOfLifeClassifier(model_str="hf-hub:imageomics/bioclip-2", device="cpu")
print(tree.predict("photo.jpg", Rank.GENUS, k=5))
```

The [CLI tutorial](https://imageomics.github.io/pybioclip/command-line-tutorial/)
also supports `bioclip predict --cls names.txt --k 5 photo.jpg`, taxonomic
`--rank genus`, `--subset` and `--bins`. These are source-checked API examples,
not commands executed during this research: first use downloads model weights
and, for TreeOfLife, its embedding/name files.

For reproducibility, [version 2.1.6](https://github.com/Imageomics/pybioclip/blob/256e467401a57c5e2cd8acb1467fbd834d757e9d/src/bioclip/predict.py#L157-L204)
uses direct 224×224 tensor resizing for these model strings; do not assume its
numbers equal the app's pinned resize/crop policy. Its embedding downloads also
omit a revision argument. Pin weights, preprocessing, candidate strings and
embedding revisions before comparing numerical results.

The official [iNaturalist notebook](https://github.com/Imageomics/pybioclip/blob/256e467401a57c5e2cd8acb1467fbd834d757e9d/examples/iNaturalistPredict.ipynb)
uses `pyinaturalist` to retrieve observation photos, then calls
`TreeOfLifeClassifier.predict(..., Rank.SPECIES, k=1)` and joins results with
observations. That is BioCLIP applied to iNaturalist images, not evidence of
iNaturalist's own deployed model or probability calibration. The package also
provides [taxonomy subsetting](https://github.com/Imageomics/pybioclip/blob/256e467401a57c5e2cd8acb1467fbd834d757e9d/examples/TOL-Subsetting.ipynb)
and separately trained few-shot SVM/Ridge/SimpleShot notebooks.

## Existing official user interfaces

| App and immutable source | Actual score presentation/behavior | What it establishes |
| --- | --- | --- |
| [BioCLIP 2 Demo](https://huggingface.co/spaces/imageomics/bioclip-2-demo), [app.py at `4768b0d8…`](https://huggingface.co/spaces/imageomics/bioclip-2-demo/blob/4768b0d8b743582f6eaa058fde15d303ed073522/app.py#L115-L185) | Gradio `Label`, five results; separate Open-Ended taxonomy and Zero-Shot custom-label tabs. Normalized features → learned-scale softmax. Higher ranks sum species mass; custom labels use prompt ensembles. | Concrete precedent for relative model-score bars and a rank selector. “Open-ended” searches the available TreeOfLife labels; it does not mean a proved out-of-catalog rejection system. |
| [BioCLIP Image Search Lite](https://huggingface.co/spaces/imageomics/bioclip-image-search-lite), [model service at `9a45f1a4…`](https://huggingface.co/spaces/imageomics/bioclip-image-search-lite/blob/9a45f1a4e348b2f997b3f3a39711ac645ee372a6/src/bioclip_lite/services/model_service.py#L186-L246) | Separates image-neighbor retrieval from taxonomic prediction; prediction reuses normalized image embeddings through pybioclip and sums children for higher ranks. | Image-to-image retrieval distance and image-to-label class scores are distinct outputs. |
| Same Lite app, [display source](https://huggingface.co/spaces/imageomics/bioclip-image-search-lite/blob/9a45f1a4e348b2f997b3f3a39711ac645ee372a6/app.py#L651-L695) | Converts softmax score to percent, rounds to whole percent, draws bars, and changes bar color at 50% and 10%. | These thresholds are presentation colors in this source, not an accepted/rejected identification decision or a validated accuracy guarantee. |

The live HF APIs reported both spaces RUNNING at the research time; no image
was submitted and their rendering/inference was not exercised. The official
[demo guide](https://imageomics.github.io/bioclip-ecosystem/pages/demos.html)
documents their taxonomy, search and source-comparison workflows. The older
BioCLIP-v1 demo is a separate model and its Space was paused when opened.

## What the primary evidence does not justify

The paper's [Herbarium19 new-species experiment](https://arxiv.org/html/2505.23883v2#A8)
uses semi-supervised clustering with known and unknown images **and a supplied
total species count**. It is not an arbitrary-single-photo cutoff. The paper
reports classification and downstream task performance, not a validated PFAF
probability scale or a universal threshold. Its training/embedding geometry
analysis should not be read as a calibration guarantee.

A particularly useful counterexample is the official
[geo-restricted-label tutorial](https://imageomics.github.io/pybioclip/geo-restricted-taxa/):
for a nēnē/Hawaiian goose photo, unrestricted prediction ranks the wrong
`Grus grus` first with score about **0.750**; using a geographically restricted
custom list changes the top answer to `Branta sandvicensis` at about **0.771**.
The tutorial explicitly discusses omitted/anomalous species as a restriction
risk. This demonstrates candidate/domain dependence, not a universal 75% rule.

## Supported next decisions for Plant Friends

1. Keep ranking and the current model unchanged while choosing presentation.
   Current [`scoring.ts`](../src/inference/scoring.ts) normalizes the image and
   computes dot products against the unit label vectors; [`model.py`](../tools/plant_assets/model.py)
   builds the normalized scientific-name prompt means. [`App.tsx`](../src/App.tsx)
   prints three decimals and “similarity.” Calling this a match/similarity score
   is accurate; calling it a probability of correctness is unsupported.
2. If numbers remain, use a short explanation such as “Similarity to names in
   this catalog; not a probability.” Ordered suggestions without an exposed
   number are also compatible with the unchanged ranking. Which presentation
   users understand best is a usability decision, not proved by these papers.
3. If an optional library-style percentage is added later, call it a relative
   model score among the declared catalog candidates, pin the logit scale and
   compute the full denominator. It will not improve top-k ranking or create
   an unknown class. It should not inherit color/acceptance thresholds merely
   because another demo has them.
4. Develop any correctness estimate/abstention rule against held-out deployment
   examples, including absent species, non-plants, difficult/partial photos and
   alternate names. Choose accepted-error versus coverage targets before
   selecting a cutoff, and evaluate it separately from selecting it. Exact
   methodology and broader calibration/OOD sources remain the coordinator's
   research domain.
5. Existing [`desktop-benchmark.json`](desktop-benchmark.json) records 14/24
   positive top-one and 21/24 top-five matches, plus four negatives, and calls
   the sample descriptive. These aggregate results do not establish score-bin
   correctness, class-wide coverage or a reliable rejection threshold. The
   supplemental reference photos have not thereby become a validated
   calibration dataset.
