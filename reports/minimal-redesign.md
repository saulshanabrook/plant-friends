# Minimal app, resumable setup and offline reference photos

## Accepted scope

Native HTML headings, buttons, inputs, table and dialog with minimal CSS. Photo controls and matches come first, then one compact automatic progress/status area, then the plant table. No download management controls, pause preference, consent checkbox or top-heavy Downloads section. All catalog/model/reference-photo downloads start automatically, in that priority order. Keep explicit Identify, essential plant hazards and source attribution. Preserve existing catalog/model identities, local user-photo handling and installed-pack compatibility. Physical phone testing remains deferred.

User authorization covers direct commits/pushes to main and GitHub Pages. No Python inference server: Python only prepares immutable static files. Parent pfaf-data checkout remains untouched. Photos are sourced from the clean PR #3 worktree, never a glob of historical downloads or fuzzy name matches.

## Ownership and final gates

| Owner | Domain | Output / stop |
| --- | --- | --- |
| Coordinator | Shared state, Claude consultation, integration, final browser checks, release/main/Pages | Publish coherent source and pinned separate photo bundle; verify actual public resume and offline inference/images. |
| Interface | App, style, details, core setup hook/source and UI tests in minimal-interface worktree | Frozen native automatic-only UI, then actual photo module wiring and focused regressions. |
| Assets/table | Native table, offline photo preparation, archive/metadata and tests in minimal-table worktree | Exact source/credit mapping, bounded derivatives, separate verified release; independent photo runtime review. |
| Storage/runtime | Core durable range storage, photo cache/hook and service worker in minimal-download worktree | Legacy compatibility, interruption/reload resume, integrity before activation; native images and all-photo offline cache. |

Coordinator owns broad final gates; workers own scoped checks. Workers use isolated worktrees and no remote writes. Root public/photos is the sole authorized shared generated namespace. Base and automatic-only slices are preserved as ignored .cache patch artifacts before the image slice. Integrate only frozen owned files.

## Design and standards evidence

Both requested Claude subprocess consultations completed using actual `claude-fable-5-1`, no tools or code edits: [initial structure](claude-fable-design.md), [revised ordering](claude-fable-order.md). Adopt native HTML and one-page camera/results/progress/table order. Native sorting/filtering/pagination is sufficient after checking [TanStack documentation](https://tanstack.com/table/latest/docs/framework/react/quick-start); no table dependency. Do not introduce an uncalibrated confidence threshold or imply missing hazard data means safe.

[HTTP Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests) supports resumable partial downloads. [Background Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Background_Fetch_API) is not broadly available; [Chrome's guide](https://developer.chrome.com/blog/background-fetch) explains that ordinary long-running service-worker work can be terminated. Cross-browser behavior therefore uses durable 8 MiB chunks, exact 206 Content-Range/length validation and full original SHA-256 verification before activation. Completed chunks survive connection loss/reopening; legacy complete files remain reusable without a duplicate model-sized write. Visible transport stalls time out after 30 seconds. Recovery has bounded transport retries and later online/visible/reload events; no tight error loop.

A [screen wake lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) reduces accidental sleep while visible but cannot guarantee execution while locked. Locked-phone background completion is not claimed. Browser eviction or data clearing still requires a new download.

## Data and sizes

Catalog ID `39831ede5fe0b995b55c`, model ID `e2b03528fe84908219e7`; no model/text regeneration. All 8,796 text records matched the photo-source snapshot. Native JSON totals 42,820,214 bytes decoded (40.8 MiB), about 4,868 bytes per record; live Pages gzip transferred 7,608,520 bytes across 36 files (7.3 MiB). Prose dominates. Local gzip6 was 7,413,079 bytes and Brotli5 5,376,003 bytes. Arrow/Parquet would add a browser decoder without a demonstrated need; retain bounded shards and HTTP compression.

The table extracts family, synonyms and three nullable PFAF use ratings sequentially from the 35 saved detail shards, retaining compact metadata. It supports search, family/minimum-rating filters, six sortable data columns, a photo column, 25/50/100-row pages and keyboard record opening. Missing ratings sort last in both directions; zero remains zero.

Photo source: [merged pfaf-data PR #3](https://github.com/saulshanabrook/pfaf-data/pull/3), commit `1dce664c55eb97844673b83b2379106e41e05908`, SQLite SHA-256 `65c43f089fbc4a12a1844a9c88570a2db68697452f0768f38e6bb824b3d3370a`. Canonical join is plant_images.url to successful image_downloads.url; every original body hash matched. 12,370 verified URLs / 12,438 associations cover 6,535 plants; 2,261 have no verified photo. A failed refreshed plant's older associations stay excluded. One source photo is 1×1; the app does not invent missing content.

User explicitly confirmed downloading ALL reference photos. Each has one orientation-corrected max-640px WebP quality75 version, no upscale. Physical deduplication yields 12,347 files / 165,263,924 bytes (157.6 MiB); manifest 9,801,679 bytes. Credits remain per association, including different credits for shared images. Original URLs, hashes and refresh metadata remain in the manifest. Photos retain their source rights and are not relicensed under the model/software license.

Supplemental photo ID `e2e188337de47653c182` binds the unchanged catalog. Separate release archive 169,456,371 bytes, SHA-256 `ced6f1ff310c6fbc72382153af28b8a655b857e5690971bb95fcaf0a32ed632c`, with 12,350 pinned regular files / 175,461,429 expanded bytes. Do not deploy the archive itself. Clean core build plus photos measured about 882.6 MB; final site gate enforces <1 GB and regular files only.

Photo metadata is validated and saved offline. Visible images may load before model completion; bulk caching starts afterward, with six bounded requests, atomic verified image writes and shared native-image service-worker caching. Reopening inventories keys rather than rehashing 12,000 bodies. Images appear in matches, table and details with recorded credit/source links; no placeholder plant photos for missing records.

## Verification state

- Automatic-only checkpoint: root typecheck and 100 unit tests passed; UI worker 17 production browser tests and 11 focused units passed.
- Core storage: 76 scoped units and six actual Chrome Cache/IndexedDB tests passed. The browser interrupt/reload test resumed at byte 8,388,608, verified the exact final offline hash and no duplicated whole-file body. Wrong ranges, hash/size errors, interrupted writes, pending ownership, legacy caches, stalled headers/body and WASM MIME are covered.
- Photo preparation: six Python tests, three archive tests, eight table tests and scoped type/mypy checks passed. Actual full archive create, clean restore and verification passed for all 12,350 files. Archive authentication precedes extraction; extras/links/corruption are rejected.
- Integrated production build/typecheck, 136 unit tests, seven deployment archive tests and six focused Python photo tests passed. The interface worker passed all 18 production UI tests, including actual two-image credits/source links and a genuine plant with no photos. Root [project-path browser verification](minimal-subpath.json) passed automatic real-catalog setup, same-origin native reference images before and after offline navigation, plant details/legal notices and 1280/390-pixel no-page-overflow checks. Model payloads were deliberately denied in that bounded fixture; no inference claim. Every selected core/photo file was verified after the build; final size 882,660,140 bytes, with only 14 small app-shell precache entries.
- Actual public interrupted-model/reopen/offline identification and full-album checks: pending. See final report when completed. Do not infer physical phone success from desktop analogues.

Final integration repair: a deliberate model transport failure reproduced a reset of Family/minimum-rating/page selections during retry. Reusing the still-present validated catalog receipt and index for the same immutable manifest ID/address preserves those controls. The regression failed before repair, then passed alongside the stale-index regression (2/2); final root typecheck,136units and production build passed. No table algorithm change.
