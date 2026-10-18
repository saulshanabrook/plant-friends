# Real-pack Cache installation diagnostic

Status: persistent-profile installation passed with the unchanged production installer. The coordinator's original incognito failure remains in `reports/feasibility-incognito-failure.json` in the main worktree; this probe did not overwrite it. This check did not load ONNX Runtime, request a GPU, or run inference.

Reproduce from the repository root while the production preview serves port 4173:

```sh
node tests/assets/large-install-diagnostic.mjs
```

The probe uses a dedicated headed Chrome persistent profile at `.cache/assets-large-install-profile`, records exact CDP network byte checkpoints and Cache.put call outcomes without transforming or cloning responses, and writes `large-install-diagnostic.json`. Running again reuses verified files in that profile; move to a new profile to measure another cold install.

The 2026-10-17 run used Chrome 155.0.8059.80. The 608,381,536-byte encoder Cache.put succeeded, followed by the full 636,777,585-byte identification pack. Both the matching PFAF and model receipts activated. Origin usage ended at 680,380,324 bytes; storage.estimate reported quota 11,417,798,564 bytes, and CDP reported 296,630,877,388 bytes. The encoder request delivered exactly 608,381,536 uncompressed data bytes, and the installer reached its normal verified activation path without an integrity error.

The same app code previously failed Cache.put with UnknownError in Playwright's default incognito context. Changing to a persistent context discriminates a browser-context/backend limitation from a deterministic installer-stream defect. This experiment does not establish the exact internal Chrome limit or claim that every incognito profile fails. The underlying browser mechanism remains inferred; no automatic private-mode detection or backend switch was added.

After the successful real probe, the coordinator requested an actionable error mapping. A new unit regression first reproduced the leaked “Unexpected internal error” text. The narrow Cache.put catch now suggests a regular window, allowing site storage, or freeing space; a separate regression preserves an underlying stream integrity error's precedence. Both also check activation safety/catalog availability. The scoped manifest/storage suite passes 56 tests; scoped TypeScript checking passes.

Next gate belongs to the coordinator: real model initialization, inference, numerical checks and production offline identification in a persistent browser profile. The populated diagnostic profile is closed and retained for possible cache reuse.
