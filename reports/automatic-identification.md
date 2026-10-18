# Automatic identification

Mission: identify a selected upload or captured still automatically, waiting for compatible saved assets when necessary. Preserve session-only photos, cancellation, latest-photo results, offline behavior and failure recovery. No score/model changes, live video recognition, new weights or physical phone test. Existing main/Pages publication authorization remains active.

| Owner | Domain and authority | Acceptance / stop |
| --- | --- | --- |
| Interface worker | App.tsx and a meaningful orchestration module/test only if needed; isolated minimal-interface | One attempt per photo/compatible pack, automatic readiness transition, cancellation/replacement/error races handled, minimal busy/retry UI. Freeze reviewed files; no binaries or deployment. |
| Compatibility worker | README, manual/integration scripts, scripts/benchmark.mjs; isolated minimal-table | Remove explicit Identify clicks from real public/offline flows and assert automatic results. Preserve historical evidence and direct numerical benchmarks; source/type checks only. |
| Coordinator | Browser regression seams, existing UI assertions, synthesis and final integration/Pages | Explicitly labeled simulated inference orchestration tests for pending load/readiness/replacement/cancel/retry/capture; real catalog cache retained in ordinary UI gates. Review, scoped checks, publish and verify current public bundle. |

Research summary requested separately: Fable recommends equally styled ranked suggestions, no default probability/confidence badges, canonical taxonomy before aggregating aliases, absent-species competitors and representative held-out evaluation before thresholds. Its prediction about negative names remains a hypothesis; source-backed corrections and caveats are in claude-fable-similarity.md and similarity-research.md.

Implementation: a selected, validated photo receives one automatic attempt for each compatible pack version. A shared model load survives photo replacement; only the current photo may submit or publish a result. Cancellation and errors wait for explicit Retry. Reset and replacement invalidate the previous attempt before photo decoding. Upload and camera capture use the same path. Reference-photo downloads do not block identification. Model weights, inference worker, ranking and similarity display are unchanged.

Validation on 2026-10-17:

- TypeScript and all 171 unit tests passed, including 13 deferred-transport lifecycle cases. An independent read-only race review found no concrete correctness issue.
- All 32 selected production-browser cases passed: automatic identification, header/install, photo/camera lifecycle, keyboard, privacy and automatic setup. Ordinary interaction cases retain their verified catalog cache between fresh pages.
- The six automatic-ID cases passed again after adding explicit waiting-status and offline-replacement assertions. They exercise the actual installer and InferenceClient with tiny fabricated packs and a labeled simulated Worker protocol; they do not claim GPU/model accuracy. Camera capture uses a labeled synthetic stream, not a physical phone or camera.
- The new browser readiness case failed against the previous app because the initial Identify button was still present, then passed with the implementation. Browser traces are local scratch.
- Root and `/plant-friends/` production builds passed. Deployment receipts verified all 47 core files (706,366,029 bytes) and 12,350 photo files (175,461,429 bytes); the selected site is 882,677,642 bytes, below the 950 MB gate.
- Updated manual/public/offline and full-model benchmark entry points now await automatic results. Node syntax checks passed; those full-model runs were not repeated because the inference pipeline is unchanged. The bounded published interface check separately verifies the deployed bundle and missing initial Identify button.
