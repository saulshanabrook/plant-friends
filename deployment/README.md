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
