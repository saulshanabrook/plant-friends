# Desktop camera verification

Status: passed with a real desktop camera in Chrome. The earlier pending-request result is superseded by this successful retry after the user reported allowing camera access. Physical phone and screen-reader operation remain untested.

The [JSON evidence](camera-native.json) records the production check at `2026-10-18T00:05:54.260Z` (October 17 in Los Angeles), using Chrome `155.0.8059.80` and app bundle `/assets/index-CULojg-2.js` at `http://127.0.0.1:4173`. The full sequence took 4.89 seconds.

A fresh regular persistent Chrome profile received browser camera permission. The native `getUserMedia` implementation remained unchanged, one video-input device was available, and no fake-media flags or device doubles were used. The app received a live, enabled, unmuted `1760 × 1328` video stream. A native `requestVideoFrameCallback` confirmed delivered frames, rather than relying only on video dimensions.

The product UI completed these checks:

- **Capture:** one real still appeared in the current page session at `1760 × 1328`; every camera track ended after capture.
- **Reset:** the photo preview disappeared and its object URL was revoked.
- **Navigation:** opening a fresh real stream and then choosing top-level **Explore plants**, inline **Explore the catalog**, or inline **Open offline setup** ended every stream track and removed the video preview.

No camera pixels were exported by the verification script or saved as screenshots, files, or report attachments. The captured still existed only in page memory until Reset. The fresh profile contained no local/session storage entries, no IndexedDB records, and no cached JPEG/WebP photo responses. Observed browser requests included no requests outside the app origin, no methods other than GET/HEAD, and no dedicated inference worker. No model download, inference, OS permission inspection, or system-setting change was performed. Chrome and the temporary profile were closed and removed afterward.

Historical failure: before the user reported allowing camera access, the product request stayed pending for 12 seconds and a direct native request for five seconds, with no frame or denial/not-found exception. A read-only attempt to inspect the OS permission record was itself denied; that did not establish camera permission denial. The later retry succeeded, but the exact original cause remains unproven. No OS settings were changed by the agent.

The separate simulated camera regressions remain useful for deterministic cancellation and late-stream cases. They are not the evidence for the physical-camera result above. Automated desktop keyboard evidence and qualitative review of its artifacts are recorded separately; this camera check makes no screen-reader, OS-native keyboard, or phone claim.

To reproduce with a running production preview and an available real desktop camera:

```sh
node tests/manual/camera.mjs http://127.0.0.1:4173 reports/camera-native.json
```

The script writes JSON evidence only. It grants browser camera permission in its temporary profile, leaves OS permissions unchanged, and reports a pending or failed request without repeatedly retrying it.
