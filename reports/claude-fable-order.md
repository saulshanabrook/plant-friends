# Claude Fable revised ordering

CLI-reported model: `claude-fable-5-1`. Previous proposal supplied as context with the user feedback; no tools or edits.

Photo controls first, one status line last, three downloads that start on load with no buttons.

**Ordering.** Every page: header, nav with Identify and Catalog, content, footer status. Downloads run in sequence: catalog, so the table works in seconds, then model for identification, then photos, which improve what works. Drop the Storage page, Cancel, and Save-Data exception.

```html
<header><h1>Plant Friends</h1><nav>Identify Catalog</nav></header>
<main>
  <p><button>Take photo</button> <label>Choose photo <input type=file></label></p>
  <img>
  <table><caption>Top 5 matches</caption></table>
</main>
<footer>
  <p role=status>Catalog ready. Downloading model, 212 of 632 MiB. Keep this page open.</p>
  <progress max=632 value=212>
  <details><summary>Storage</summary>Catalog 7 MiB, model 632 MiB, photos 160 MiB
    <button>Delete downloads</button></details>
  <p>Identification can be wrong…</p>
</footer>
```

**Status.** One sentence and one `<progress>` for the current item.

- Running: "Catalog ready. Downloading model, 212 of 632 MiB." then "Identification ready. Downloading photos, 40 of 160 MiB."
- Done: "Ready, offline." No bar.
- Offline: "No connection. 212 of 632 MiB saved, continues when online." Bar stays.
- Server error: "Download problem, retrying." After three failures: "Download failed, reload to retry."
- Storage full: "Not enough storage, need 420 MiB free. Free space and reload."

Resume after suspension is silent, the running line reappears. Photo controls stay enabled. A photo taken early shows with the caption "Identifies when the model finishes" and runs on its own.

**Background limits.** Phones suspend the page on screen lock or app switch, which stops the chunk loop. Only Chrome on Android could continue via Background Fetch, skip that second path. Request a screen wake lock while downloading, show "Keep this page open" during setup, and let chunk resume cover the rest. Call storage.persist at model download start, since partial chunks are the eviction risk.
