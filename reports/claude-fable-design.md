# Claude Fable design consultation

Requested model alias: `fable`. CLI-reported model: `claude-fable-5-1`. Invoked via local Claude Code subprocess with no tools or edits.

Proposal: four hash routes, one live status line, a native table with in-memory sort and filter, no table library.

## Pages and workflow

**Shell.** `<header>` with h1 "Plant Friends" and a nav of three links: Identify, Catalog, Storage. Footer: one caution, "Identification can be wrong. Never eat a plant on this app's say-so", and a `<details>` "Sources and licenses" listing PFAF, BioCLIP 2, runtime, repo. Hash routes keep the project path working offline.

**Identify, #/.** A live status paragraph first, reading "Ready, offline" or the download line. Then two controls. "Take photo" opens a `<dialog>` with live video plus "Capture" and "Cancel". "Choose photo" is a file input accepting JPEG, PNG, WebP. Identification starts on capture or selection. Results are a `<table>` captioned "Top 5 matches": Score, Scientific name as a link, Common name, Edibility, Hazards. A predicted taxon with no PFAF record still appears with "No catalog record" in the name cell. A low top score sets the status to "Low score, treat as a guess". Without a model the buttons are disabled and the status says why.

**Plant record, #/plant/ID.** h1 Latin name. A paragraph with common names and family. A paragraph "Hazards: ..." always present, reading "Hazards: none recorded" when empty. A two-column `<table>`: Edibility, Medicinal, Other uses as "3 of 5", zero shown as "0 of 5", missing as "unknown", then Habit, Height, Hardiness, Range. h2 sections Edible uses, Medicinal uses, Other uses as paragraphs, each reading "Not recorded" when empty. `<details>` for Cultivation, Propagation, and Source with the PFAF link and license. "Back to catalog" restores the previous filters.

## First-run setup

- On every load read manifest.json, listing the catalog file and model shards with sizes and hashes, and check a versioned Cache Storage cache. If all verify, nothing downloads and the status says "Ready, offline".
- Otherwise download automatically, catalog then model, as one status line with a `<progress>` and a Cancel button: "Catalog: 2 of 3 MiB", then "Model: 212 of 632 MiB". When Save-Data is on, skip the model auto-start and show "Download model, 632 MiB" instead.
- Shards of about 16 MiB are stored only when complete and verified. Cancel and failure keep finished shards. Retry and later loads resume from the first missing shard, so a flaky connection never repeats the whole download.
- A user cancel is remembered in localStorage and stops auto-restart. Status then reads "Model not downloaded" with "Download, 632 MiB". Failure reads "Model download failed: offline" or the HTTP status, with "Retry".
- No automatic deletion. A new manifest version downloads into a new cache name, and the old cache goes only after the new one verifies. Delete lives only on Storage behind a `<dialog>` confirm and clears the cancel flag.
- Call storage.persist once after the model verifies. Storage page: rows Catalog and Model with size, state, date, and only the applicable buttons among Download, Cancel, Retry, Delete. Then "Persistent storage: yes/no" with "Request", the app version, and "Update available. Reload" when a service worker waits.

## Catalog table

- No library. Filter, sort, and slice the 8,796 records in one useMemo over precomputed lowercase keys with an Intl.Collator. TanStack Table would add an offline-bundle dependency for resizing, grouping, and virtualization you will not use. State is query, three minimum ratings, hazards, habit, sort key, direction, page, mirrored into the hash query so reload and back keep it.
- Filters are a `<form>` above the table, applied on change, with a native reset button "Clear". Search input "Name" matches Latin, common, and family. Selects "Edibility at least", "Medicinal at least", "Other uses at least" offer Any and 1 to 5. Select "Hazards" offers Any, None recorded, Recorded. Select "Habit" lists distinct values. Missing ratings never satisfy a minimum.
- Columns: Scientific name as a link, Common name, Family, Edibility, Medicinal, Other uses, Hazards recorded. Zero prints "0". Missing prints a blank cell. Hazards prints "yes" or blank.
- Each `<th scope="col">` wraps a button toggling ascending then descending and setting aria-sort. Default is scientific name ascending. Numeric sorts put missing last in both directions.
- Page size 50. The `<caption>` reads "412 of 8,796 plants, page 1 of 9". Controls: "Previous", "Next", and a number input "Page" with min and max. Any filter or sort change resets to page 1.
- Mobile: one div with overflow-x auto around the table, and a media query under 40em hides Family and Other uses. No card fallback.

**HTML and CSS.** Only main, nav, headings, p, labeled form controls, table parts, details, dialog, progress, img, video, plus that one scroll div. The status paragraph has role status so download and identification changes are announced. Dialogs open with showModal for the native focus trap and Escape. The stylesheet is about 25 lines: color-scheme light dark, a 70ch centered body in system-ui, 1px collapsed table borders, left-aligned th, img max-width 100%, the scroll wrapper, the media query. No colors, icons, or classes.
