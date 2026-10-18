# Labeled evaluation photographs

`photos.json` is the source manifest for a bounded, licensed evaluation set. Retrieve or verify its pinned files from the repository root:

```sh
uv run python -m tools.plant_assets fixtures --manifest fixtures/photos.json
```

The set contains 24 positive PFAF examples (two photographs for each of 12 preserved catalog source keys) and four negative examples: two plants whose exact scientific names are absent from this PFAF snapshot and two non-plant bird observations. All photographs come from distinct public iNaturalist observations with CC0 or CC BY photo licenses. Each entry records the observation and photo source URLs, author and verbatim attribution, license URL, download URL, file SHA-256, dimensions, and recorded iNaturalist taxon.

| Negative category | Recorded scientific name | File | Observation / author | Photo license |
| --- | --- | --- | --- | --- |
| Out-of-catalog plant | Phalaenopsis amabilis | `inat-366447886.jpg` | [207195050](https://www.inaturalist.org/observations/207195050) / Tom Heijnen | CC BY |
| Out-of-catalog plant | Cattleya labiata | `inat-253889943.jpg` | [147536428](https://www.inaturalist.org/observations/147536428) / Carlos Otávio Gussoni | CC BY |
| Non-plant bird | Turdus migratorius | `inat-23068.jpg` | [11298](https://www.inaturalist.org/observations/11298) / dloarie | CC BY |
| Non-plant bird | Passer domesticus | `inat-19666.jpg` | [9170](https://www.inaturalist.org/observations/9170) / John Proctor | CC BY |

The bird photographs include vegetation and other scene context; the last photograph has small bird subjects. These are labeled observation photographs, not isolated object cutouts.

Positive examples have a non-null `expectedTaxonId`; include only those 24 photographs in positive top-one/top-five classification totals. Negatives have `expectedTaxonId: null`, an explicit `negativeKind`, and `catalogAbsence` evidence bound to the source database hash. Record their raw possible PFAF matches separately. A null expected ID does not require or imply automatic membership detection or rejection: the app ranks candidates within PFAF even for unrelated inputs.

Absence checks compare the recorded scientific name against trimmed PFAF source keys without case sensitivity. They do not resolve synonyms, infer taxonomic equivalence, or assert that the broader biological species has no related catalog entry. Non-plant categories use the recorded iNaturalist iconic taxon group. Tests recheck source-key membership/absence against the read-only SQLite source, require 24 positives and four negatives, and preserve a hash of all original positive metadata.

The photos are unmodified downloaded medium images. The numerical pipeline separately records orientation, color, compositing, resize, crop, and normalization behavior. Full attribution remains in `photos.json`; do not treat an observation's metadata license as its photo license. Selection follows [iNaturalist's recommended API practices](https://www.inaturalist.org/pages/api%2Brecommended%2Bpractices), using bounded queries, an identifying user agent, throttling, and cached downloads.

This small descriptive set may overlap BioCLIP pretraining and is not an independent accuracy guarantee. Negative examples expose possible matches on unrelated inputs; they do not establish a calibrated unknown-class detector. Physical-phone behavior is untested.
