# Published model download investigation

Mission: reproduce and fix the reported GitHub Pages model-download failure, preserving the full model and browser-side/offline inference. Direct-main publication remains authorized by the prior request. No phone-performance claim.

Observation: user reports inability to download the model from the published app. Device, browser, failure stage and error are pending. Previous desktop public-origin installation and offline identification passed at dc0f6ee; this does not establish the user's environment works now.

Hypotheses and discriminating predictions:

- Hosting/file mismatch: current manifest or model request fails, changes size/hash, or points outside project scope. Current public network probes should expose it independently of browser storage.
- Browser/API/storage failure: current assets are healthy but quota, private mode, missing cache support or storing the large response fails. A matching environment or bounded storage repro should fail before activation while preserving installed packs.
- UI/prerequisite mismatch: button availability, stale service worker or error presentation prevents or obscures download. Direct installer and actual setup UI will differ.

| Agent | Domain / authority | Output / stop |
| --- | --- | --- |
| coordinator | user clarification, shared state, browser reproduction and final verification/deployment | Evidence-driven fix accepted only after target repro and nearby regression pass. |
| assets | read-only current public pointers/manifests, encoder/runtime HTTP behavior and release/Pages metadata | Concrete current mismatch or clean bounded network result; no edits or remote writes. |
| ui | read-only client download prerequisites/storage/error paths and existing regression evidence | Concrete likely branches and minimal discriminating repro; no edits until implementation is assigned. |

No implementation selected yet. Next decision: use current network evidence and user's device/error to choose one smallest repro. Stop speculative code changes when the evidence does not distinguish hypotheses.

Read-only client findings: catalog installation and checkbox opt-in gate the model action; download is not gated by WebGPU. Prior public verification called the diagnostic installer directly. Source metadata requests have no timeout, installation uses AbortSignal.any unconditionally, and installation can queue behind a Web Lock. Each remains an alternative until the actual failure stage is known. Prior incognito Cache.put UnknownError is documented in tests/assets/large-install-diagnostic.md; its exact internal browser cause was not proven.

Current bounded product probe: a fresh regular Chrome 155 profile opened the actual public app, installed the catalog through Offline setup, and showed no page/request errors. The model control was disabled while its size checkbox remained unchecked, as designed. Raw exploratory evidence is .cache/pages-download-ui-probe.json. A second fresh run selected the checkbox and completed the model download through the actual product controls, then verified offline persistence. This tests the product path omitted by the earlier direct-installer publication check; no implementation changed.

Current result: full published model installation via the actual UI PASSED in regular Chrome 155 (93.6 seconds for the model), followed by fresh offline navigation showing both packs installed. No page errors or failed requests occurred. Temporary profiles were removed. Current pointers/manifests match every pinned byte/hash; encoder/runtime end ranges, all five model-file HEADs and JS decoding/hash were healthy. This rules out a deterministic failure in the tested normal Chrome UI path and current asset identity/path publication; it does not rule out user-specific browser storage, unsupported APIs, network interruption or a disabled control.

Next required evidence: user's device/browser, disabled-vs-started behavior and any actual error text or last progress state. No app changes were made and no failure-specific fix was selected. Do not repeat successful full downloads without new environment evidence; use the smallest discriminating browser/storage/control probe for the reported branch.

User supplied the missing failure mechanism in the next turn: phone screen lock/network loss interrupts the large identification file; retry spends time preparing and does not resume within that file. This is an acknowledged storage design limitation, now included with the requested visual redesign in [minimal-redesign.md](minimal-redesign.md). The existing whole-file Cache.put cannot persist an interrupted encoder prefix; completed smaller files alone survive. Root/worker ownership and accepted durable-chunk repair are recorded there.
