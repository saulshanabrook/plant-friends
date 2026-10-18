# Matrix-storage FP16 with FP32 arithmetic: native GPU result

This exact candidate passes all nine unchanged saved-tensor numerical gates against the FP32 reference, with no top-five ordering changes across the 12 installed scientific-name vectors. It is suitable for the next production-worker feasibility check. This is a main-thread diagnostic, not final full-catalog/offline acceptance.

The actual browser fetched and verified **609,029,031 bytes** with SHA-256 **`fd3f7ee590ea91e04bf8ef0e104fc536e28d7ff1518b7638c947da7eede733cb`**. The independently prepared structural descriptor is `/Users/saul/p/plant-friends/public/packs/bioclip2/experiments/weight-storage-fp16.json`, and the model is its sibling `weight-storage-fp16.onnx`. The descriptor reports recipe `fp16-matrix-storage-fp32-arithmetic-v1`: 99 large initializers stored as FP16 and explicitly cast to original FP32 names, 197 initializers preserved, with original graph arithmetic, nodes, I/O and value metadata retained. The browser probe independently verifies file identity, outputs and generated shader types; it does not repeat Python's complete graph-structure proof.

The probe used the same nine input hashes, original checked FP32 embeddings, 12 text vectors, current thresholds and native runtime pair as the baseline. The base production pointer was not edited by this experiment. `modelIdentity` in the JSON records that unchanged reference pack; `encoderIdentity` identifies the experimental file actually executed.

| Input | Reference dot/cosine metric | Max normalized coordinate error | Max score error, 12 vectors | session.run ms |
| --- | ---: | ---: | ---: | ---: |
| 16418 | 0.9999999986 | 5.20246e-6 | 4.60120e-6 | 554.0 |
| 50800 | 0.9999999999 | 8.18438e-6 | 6.77680e-6 | 144.6 |
| 22158 | 1.0000000010 | 3.63720e-6 | 1.74759e-6 | 143.7 |
| portrait | 0.9999999960 | 1.14641e-5 | 1.22423e-5 | 145.3 |
| landscape | 1.0000000004 | 4.10388e-6 | 2.45821e-6 | 144.5 |
| small | 0.9999999983 | 5.92084e-6 | 4.76143e-6 | 144.5 |
| transparent | 0.9999999991 | 3.17321e-6 | 3.53577e-6 | 143.3 |
| oriented | 0.9999999979 | 5.39417e-6 | 4.71514e-6 | 143.8 |
| webp | 1.0000000004 | 4.10388e-6 | 2.45821e-6 | 143.6 |

The minimum reference agreement metric is **0.9999999959935982**, maximum normalized coordinate error **0.000011464103274277026**, and maximum 12-vector score error **0.000012242276216746127**. The existing score gate remains **0.002**. The dot/cosine calculation intentionally matches the application's comparison formula, including Float32 normalization; negligible norm rounding (at most 2.46e-9) can yield a dot product slightly above one. Exact recorded metrics are retained rather than silently clamped.

Chrome **155.0.8059.80** used an explicit Apple `metal-3` hardware device (`isFallbackAdapter:false`) with `ort.webgpu.min.mjs` and the matching **ORT 1.30.0 native Asyncify** JavaScript/WASM pair. Runtime requests and hashes are in the JSON. Node-placement logs assign all **875 optimized nodes** to `WebGpuExecutionProvider`; none are assigned to CPU. There were no ORT warnings or WebGPU errors. The actual emitted Gemm/MatMul shaders now alias both input/output element types to **`f32`**, and their accumulator declarations use those FP32 aliases. Selected shader lines and full raw logs are retained.

Each input submitted **586 actual WebGPU dispatch commands**; one initialization dispatch accounts for 5,275 total. There were 25 compute-pipeline creations. The exact instrumentation is documented in `native-webgpu-probe.md` and implemented in the shared script. It counts dispatch commands, not GPU timestamp durations.

Session creation took **1,106.1 ms**, first inference **554.0 ms**, and the remaining eight diagnostic runs had median **144.15 ms** (143.3–145.3 ms). These include output readback and verbose diagnostic instrumentation on the main thread. They are not a controlled comparison with production worker timings. The temporary Chrome profile was closed and removed.

Reproduce from this worktree with the existing local development server:

```sh
PLANT_PROBE_LABEL=weight-storage-fp16 \
PLANT_PROBE_ENCODER_URL=http://127.0.0.1:4174/packs/bioclip2/experiments/weight-storage-fp16.onnx \
PLANT_PROBE_ENCODER_SHA256=fd3f7ee590ea91e04bf8ef0e104fc536e28d7ff1518b7638c947da7eede733cb \
PLANT_PROBE_ENCODER_BYTES=609029031 \
node tests/assets/native-webgpu-probe.mjs
```

Proceed with this exact precision recipe and native Asyncify runtime in the final worker, then recheck complete photo preprocessing, worker scheduling, full catalog vectors, ten warm timings, memory observations, verified installation and a fresh offline reload/new-photo inference. No numerical limit was relaxed. The accepted manifest now names this precision policy explicitly and rejects stale JSEP runtime files, including when their version number matches.
