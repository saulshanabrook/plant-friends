# Prepared assets for GitHub Pages

`assets.json` selects one complete PFAF catalog, one complete BioCLIP 2 pack,
their shared encoder, the exact native Asyncify runtime pair, both root
pointers/manifests, and `packs/NOTICE.txt`. It records every selected file's byte
count and SHA-256. Old packs, fixture photos, reference tensors, and caches are
excluded. Website notices remain ordinary tracked public files; the archive also
contains a copy of `public/third-party-notices.txt` as `packs/NOTICE.txt` so a
downloaded release carries its own attribution and licenses.

Create the release archive once from the verified preparation directory, after
the public notice is ready. This reads that directory and does not change its
packs, pointers, runtime, fixtures, or caches:

```sh
node --test scripts/pages-assets.test.mjs
node scripts/pages-assets.mjs create --source /Users/saul/p/plant-friends/public --archive .cache/plant-friends-assets-e2b03528fe84908219e7.tar.gz
```

The command updates `deployment/assets.json` with the archive's actual size and
SHA-256. Its release URL is already selected there. Upload the resulting archive
to that exact public GitHub release URL, and retain the small updated metadata in
git. A null archive hash/size intentionally fails CI; it is not a placeholder
that permits an unchecked download. Changing assets requires a newly reviewed
selection and release receipt.

For a local import check, use a target with no generated asset namespaces:

```sh
node scripts/pages-assets.mjs restore --archive .cache/plant-friends-assets-e2b03528fe84908219e7.tar.gz --target .cache/pages-restored-public
node scripts/pages-assets.mjs verify --target .cache/pages-restored-public
```

Restore refuses existing `packs/`, `runtime/`, `fixtures/`, `model.json`, or
`catalog.json`. It never removes another preparation tree. A fresh CI checkout
contains only tracked public files, so `node scripts/pages-assets.mjs restore`
can download and restore there. The archive is authenticated before extraction,
must list exactly the pinned regular files, and every restored file is checked
again in staging before copying it into `public/`.

The workflow uses the pinned Node version, `npm ci`, and existing prepared
assets; Python, checkpoint downloads, and model export are not needed. The
installed `onnxruntime-web` version must match the selected model/runtime. After
`VITE_BASE_PATH=/plant-friends/ npm run build`, run:

```sh
node scripts/pages-assets.mjs verify --target dist
```

This detects runtime changes introduced by `copy-runtime.mjs`, missing/corrupt
selected files, or accidental inclusion of old packs/fixtures. Ordinary tracked
public files such as icons and notices are copied by Vite as usual.

The GitHub Actions workflow runs only for main pushes or manual dispatch from
main. Build permissions are `contents: read` and `pages: read`; deployment has `pages: write`,
`id-token: write`, and `actions: read` for artifact lookup, with the `github-pages`
environment and serialized deployment concurrency. The coordinator configures
Pages and publishes the release; the workflow does not create releases or
change repository settings.

Action versions and exact release commit SHAs were read from the official GitHub
release/tag APIs on 2026-10-17: [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0),
[configure-pages v6.0.0](https://github.com/actions/configure-pages/releases/tag/v6.0.0),
[upload-pages-artifact v5.0.0](https://github.com/actions/upload-pages-artifact/releases/tag/v5.0.0),
and [deploy-pages v5.0.1](https://github.com/actions/deploy-pages/releases/tag/v5.0.1).
The job/environment structure follows [GitHub's custom Pages workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Offline reference photos

`photos.json` pins a supplemental photo release to the existing catalog ID. It
does not replace or duplicate the compatible catalog/model/runtime archive.
Preparation reads the exact merged source checkout and its verified image ledger;
it never scrapes or downloads images or changes catalog/model IDs:

```sh
uv run --locked python -m tools.plant_assets prepare-photos \
  --database ../pfaf-data/data.sqlite --source-root ../pfaf-data \
  --source-commit 1dce664c55eb97844673b83b2379106e41e05908 \
  --catalog public/packs/pfaf/39831ede5fe0b995b55c/manifest.json
node --test scripts/photos-assets.test.mjs
node scripts/photos-assets.mjs create --source public --archive .cache/photos-assets.tar.gz
```

The source checkout must be at that clean commit and contain its local image
files. Each original SHA-256 is checked before EXIF orientation, bounded resizing
(640 px longest edge, no upscale), and WebP quality 75 encoding. The manifest
retains exact original URLs/hashes, source refresh/error metadata, and every
per-plant raw credit (including null or empty text). Photo IDs hash the exact
original URL; identical derivative bytes share a physical file. Credits are
source records, not a fabricated uniform photo license. `photos/NOTICE.txt`
copies the current public notices into the release archive.

Upload the archive to the exact URL recorded in `deployment/photos.json`, then
retain the updated SHA-256/byte receipts in git. The tar.gz is release transport
only and must not be copied into the website. CI restores core assets first,
then the photos into the same fresh public directory:

```sh
node scripts/photos-assets.mjs restore
# For a local archive instead of the authenticated public release:
node scripts/photos-assets.mjs restore --archive .cache/photos-assets.tar.gz --target .cache/photo-import
node scripts/photos-assets.mjs verify --target .cache/photo-import
# After the production build:
node scripts/photos-assets.mjs verify --target dist
node scripts/photos-assets.mjs check-size --target dist
```

Restore verifies the archive before extraction, permits exactly the selected
regular files, verifies every restored receipt, and publishes the pointer last.
It refuses an existing photo namespace while leaving core pack files alone.
Post-build verification rejects stale photo versions or corrupt derivatives.
The final site-size check fails at 1,000,000,000 bytes and also reports whether
it meets the 950 MB target. Photo files are downloaded for offline use separately
from the small app-shell precache; changing the shell must not re-precache all
12,347 images.

The prepared `e2e188337de47653c182` pack contains all 12,370 verified source
photo URLs as 12,347 deduplicated WebP files (165,263,924 bytes), with 12,438
associations covering 6,535 of the 8,796 catalog plants. The remaining 2,261
plants have no current verified photo; no replacement image or fuzzy name join
is invented. One source image is a valid 1×1 image and is retained. The failed
source refresh for `Cymopterus purpurescens` is recorded in the manifest rather
than reviving its stale associations. Original source files total 313,233,218
bytes. The deterministic transformation records Pillow 13.0.0 and libwebp 1.6.0.

The manifest is 9,801,679 bytes. Including the pointer and archive notice, the
selected photo release is 175,461,429 bytes across 12,350 files; its authenticated
tar.gz is 169,456,371 bytes. Full original-hash checks, full output WebP decoding,
and an actual archive restore/every-file hash verification passed. Adding these
assets to the clean core site measured 707,182,062 bytes gives 882,643,491 bytes;
the integrated deployment must still run the post-build size check above.
