# Native WebGPU / Asyncify diagnostic

The native ORT 1.30.0 WebGPU entry runs the identical full BioCLIP 2 deployment encoder on Apple hardware, but switching entry points alone does not satisfy the existing numerical score limit. Eight of nine unchanged saved tensors exceed the unchanged maximum score-error threshold of 0.002. No production code, pack pointer, model export or tolerance was changed by this probe.

Run from this worktree while the main Vite development server serves port 4174:

```sh
node tests/assets/native-webgpu-probe.mjs
```

The exact requested runtime is `ort.webgpu.min.mjs` plus `ort-wasm-simd-threaded.asyncify.mjs` and `.wasm`, all from the installed `onnxruntime-web` **1.30.0** package. The JSON records their SHA-256 values and actual browser request URLs; no JSEP module was requested. The encoder's actual 608,381,536 bytes were SHA-256 checked against `68a909924d8ba49096734bdc893dab61a91e51215a298a04c1493d6af6707fc7` before session creation. All nine tensor hashes and reference embedding hashes were verified, together with the 12-vector file hash.

The run used headed Chrome **155.0.8059.80**, a fresh isolated persistent profile, and a blank page on the development origin. A `high-performance` adapter request with `forceFallbackAdapter:false` returned Apple `metal-3`, `isFallbackAdapter:false`, with `shader-f16` and `timestamp-query`. A device from that adapter was passed explicitly as `{name:'webgpu', device}`; WASM support used one thread and no proxy.

| Saved input | Native cosine vs FP32 | Native max coordinate error | Native max score error, 12 vectors | Existing JSEP max score error | Native session.run ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 16418 | 0.9997844910 | 0.0022670762 | 0.0030856191 | 0.0031718278 | 453.7 |
| 50800 | 0.9996536635 | 0.0035819958 | 0.0047814181 | 0.0052794730 | 92.1 |
| 22158 | 0.9998604594 | 0.0020501605 | 0.0024889996 | 0.0027170288 | 92.3 |
| portrait | 0.9995493419 | 0.0033626678 | 0.0024886076 | 0.0021989767 | 92.2 |
| landscape | 0.9996694996 | 0.0041436167 | 0.0032144895 | 0.0035845437 | 92.4 |
| small | 0.9994672909 | 0.0041612719 | 0.0044587505 | 0.0037918478 | 92.5 |
| transparent | 0.9997016820 | 0.0031586803 | 0.0009462563 | 0.0014744909 | 92.4 |
| oriented | 0.9995374358 | 0.0043588958 | 0.0031303629 | 0.0038140722 | 92.1 |
| webp | 0.9996694996 | 0.0041436167 | 0.0032144895 | 0.0035845437 | 92.2 |

Session creation took 831.9 ms. The first inference includes cold kernel compilation. The remaining eight session.run/readback observations have a median of 92.25 ms. These are exploratory main-thread timings with verbose logging and instrumentation, not a controlled speed comparison with the existing worker benchmark. The native top-five order differs from FP32 for `landscape` and `webp`.

The native placement log states that all **948 optimized nodes** are assigned to `WebGpuExecutionProvider`. The runtime also adds its standard default CPU provider, but node-placement evidence assigns it no graph nodes. Seventy-two warnings concern unavailable CPU kernels during constant folding; they do not establish execution-time fallback. No WebGPU validation error or device loss was observed.

The probe instruments `GPUComputePassEncoder.prototype.dispatchWorkgroups` and `dispatchWorkgroupsIndirect`: each wrapper increments a counter and immediately invokes the original method with the same receiver and arguments. It similarly counts `GPUDevice.prototype.createComputePipeline` and `createComputePipelineAsync`. Counter snapshots surround only `session.run`. Each input submits **659 dispatch commands**; a separate initialization dispatch produces 5,932 total. There are 28 compute-pipeline creations. This counts actual browser WebGPU dispatch calls, not GPU timestamp durations or named ONNX kernels. The exact hooks are retained in the script. The temporary browser profile was closed and removed after collection.

The raw log additionally contains the actual emitted Gemm/MatMul WGSL. Its `a_element_t` and `output_element_t` aliases are `f16`; Gemm accumulates into `array<vec4<output_element_t>>`, and MatMul uses `a_element_t` accumulators. Selected lines are preserved under `shaderEvidence` in the JSON. This supports investigating reduced-precision arithmetic across both GPU backends; it does not isolate the whole-model drift to a single operator.

Keep the existing limits. Native WebGPU is a viable performance candidate, but it is insufficient as the numerical repair. A separately identified precision experiment can reuse this script without changing production metadata:

```sh
PLANT_PROBE_LABEL=weight-storage-fp16 \
PLANT_PROBE_ENCODER_URL=http://127.0.0.1:4174/packs/bioclip2/experiments/weight-storage-fp16.onnx \
PLANT_PROBE_ENCODER_SHA256=<exact-candidate-sha256> \
PLANT_PROBE_ENCODER_BYTES=<exact-candidate-byte-count> \
node tests/assets/native-webgpu-probe.mjs
```

All three encoder overrides are required together, the URL must stay on the same local origin, and a labeled report preserves this baseline. Inputs, reference embeddings, text vectors and tolerances remain the original set. This is a developer diagnostic override only; no application API accepts it. The candidate must be prepared and explicitly authorized before running this command.
