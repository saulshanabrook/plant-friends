"""Compare a deployed FP16 ONNX graph on CPU against recorded FP32 inputs/outputs.

This standalone diagnostic reads an existing pack and references; it never loads
or downloads a checkpoint, exports a model, or changes acceptance tolerances.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import platform
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from numpy.typing import NDArray


def normalized_scores(embedding: NDArray[np.float32], vectors: NDArray[np.float32]) -> tuple[NDArray[np.float32], list[float]]:
    """Match browser FP64 accumulation, FP32 normalization, and FP64 dot products."""
    if embedding.shape != (768,) or not np.isfinite(embedding).all():
        raise ValueError("Expected one finite 768-dimensional image embedding")
    norm = math.sqrt(sum(float(value) * float(value) for value in embedding))
    if norm < 1e-12:
        raise ValueError("Expected a nonzero image embedding")
    normalized = np.asarray([float(value) / norm for value in embedding], dtype=np.float32)
    scores = [sum(float(left) * float(right) for left, right in zip(normalized, row, strict=True)) for row in vectors]
    return normalized, scores


def diagnose(pack_path: Path, reference_path: Path, output: Path) -> None:
    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    references = json.loads(reference_path.read_text(encoding="utf-8"))
    if references["packId"] != pack["id"]:
        raise ValueError("Recorded FP32 references and deployed pack have different identities")
    output.parent.mkdir(parents=True, exist_ok=True)
    embeddings = output.parent / "fp16-cpu-embeddings"
    embeddings.mkdir(exist_ok=True)
    verified: dict[str, str] = {}
    for asset in [pack["model"]["file"], pack["vectors"]["file"], pack["catalog"]["rows"]]:
        path = pack_path.parent / asset["url"]
        with path.open("rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        if digest != asset["sha256"] or path.stat().st_size != asset["bytes"]:
            raise ValueError(f"Pack asset integrity failed: {path}")
        verified[str(path.resolve())] = digest
    vectors = np.fromfile(pack_path.parent / pack["vectors"]["file"]["url"], dtype="<f4").reshape(pack["vectors"]["shape"])
    rows = json.loads((pack_path.parent / pack["catalog"]["rows"]["url"]).read_text(encoding="utf-8"))
    if len(rows) != len(vectors) or not np.isfinite(vectors).all() or not np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-5, rtol=0):
        raise ValueError("Pack vectors or row mapping are invalid")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.enable_profiling = True
    options.profile_file_prefix = str(output.parent / "fp16-cpu-profile")
    options.log_severity_level = 3
    started = time.perf_counter()
    session = ort.InferenceSession(str(pack_path.parent / pack["model"]["file"]["url"]), sess_options=options,
                                   providers=["CPUExecutionProvider"])
    report: dict[str, Any] = {
        "schemaVersion": 1, "kind": "deployed-fp16-cpu-diagnostic", "createdAt": datetime.now(timezone.utc).isoformat(),
        "packId": pack["id"], "model": pack["model"], "catalogId": pack["catalog"]["id"],
        "vectorsSha256": pack["vectors"]["file"]["sha256"], "preprocessingSha256": pack["preprocessing"]["sha256"],
        "referenceManifest": str(reference_path.resolve()), "referenceManifestSha256": hashlib.sha256(reference_path.read_bytes()).hexdigest(),
        "environment": {"python": platform.python_version(), "platform": platform.platform(), "machine": platform.machine(),
                        "versions": {name: importlib.metadata.version(name) for name in ("onnxruntime", "numpy")}},
        "session": {"providers": session.get_providers(), "threads": 4, "executionMode": "sequential",
                    "graphOptimizationLevel": "ORT_ENABLE_ALL", "initializationMs": (time.perf_counter() - started) * 1000},
        "verifiedPackFiles": verified, "samples": [], "acceptanceGatesChanged": False,
        "limitations": ["Identical recorded tensors isolate conversion/runtime drift from image preprocessing.",
                        "CPU execution may promote FP16 operations to FP32; profile precision is reported separately.",
                        "This diagnostic is not browser numerical acceptance or a device performance benchmark."],
    }
    try:
        for sample in references["samples"]:
            for key in ("input", "embedding"):
                path = reference_path.parent / sample[f"{key}Url"]
                with path.open("rb") as file:
                    digest = hashlib.file_digest(file, "sha256").hexdigest()
                if digest != sample[f"{key}File"]["sha256"] or path.stat().st_size != sample[f"{key}File"]["bytes"]:
                    raise ValueError(f"Reference integrity failed: {path}")
            inputs = np.fromfile(reference_path.parent / sample["inputUrl"], dtype="<f4").reshape(1, 3, 224, 224)
            expected = np.fromfile(reference_path.parent / sample["embeddingUrl"], dtype="<f4")
            started = time.perf_counter()
            actual = np.asarray(session.run([pack["model"]["outputName"]], {pack["model"]["inputName"]: inputs})[0], dtype=np.float32).reshape(-1)
            elapsed = (time.perf_counter() - started) * 1000
            normalized_expected, expected_scores = normalized_scores(expected, vectors)
            normalized_actual, actual_scores = normalized_scores(actual, vectors)
            expected_norm = float(np.linalg.norm(expected.astype(np.float64)))
            actual_norm = float(np.linalg.norm(actual.astype(np.float64)))
            cosine = float(np.clip(np.dot(expected.astype(np.float64) / expected_norm, actual.astype(np.float64) / actual_norm), -1, 1))
            expected_order = sorted(range(len(rows)), key=lambda i: (-expected_scores[i], rows[i]))
            actual_order = sorted(range(len(rows)), key=lambda i: (-actual_scores[i], rows[i]))
            score_errors = [abs(left - right) for left, right in zip(expected_scores, actual_scores, strict=True)]
            actual_file = embeddings / f"{sample['id']}.embedding.f32"
            actual.astype("<f4").tofile(actual_file)
            result = {
                "id": sample["id"], "photoUrl": sample["photoUrl"], "inputFile": sample["inputFile"],
                "fp32EmbeddingFile": sample["embeddingFile"],
                "fp16CpuEmbeddingFile": {"path": str(actual_file.resolve()), "bytes": actual_file.stat().st_size,
                                          "sha256": hashlib.sha256(actual_file.read_bytes()).hexdigest()},
                "cpuInferenceMs": elapsed, "cosine": cosine,
                "maxNormalizedCoordinateError": float(np.max(np.abs(normalized_actual.astype(np.float64) - normalized_expected.astype(np.float64)))),
                "maxScoreError": max(score_errors), "maxScoreErrorTaxonId": rows[int(np.argmax(score_errors))],
                "expectedRawNorm": expected_norm, "actualRawNorm": actual_norm,
                "normalizedNormError": abs(float(np.linalg.norm(normalized_actual.astype(np.float64))) - 1),
                "entireOrderUnchanged": expected_order == actual_order,
                "topFiveOrderUnchanged": expected_order[:5] == actual_order[:5],
                "fp32TopFive": [rows[i] for i in expected_order[:5]], "fp16CpuTopFive": [rows[i] for i in actual_order[:5]],
                "fp32MinimumAdjacentScoreGap": min(abs(expected_scores[left] - expected_scores[right])
                                                  for left, right in zip(expected_order[:-1], expected_order[1:], strict=True)),
                "scores": [{"taxonId": row, "fp32": expected_scores[i], "fp16Cpu": actual_scores[i], "absoluteError": score_errors[i]}
                           for i, row in enumerate(rows)],
                "fp32OnnxReferenceCosine": sample.get("fp32OnnxCosine"),
                "fp32OnnxReferenceMaxCoordinateError": sample.get("fp32OnnxMaxEmbeddingError"),
            }
            report["samples"].append(result)
            print(f"{sample['id']}: cosine={cosine:.10f} maxCoordinate={result['maxNormalizedCoordinateError']:.8g} maxScore={max(score_errors):.8g} topFiveUnchanged={result['topFiveOrderUnchanged']}", flush=True)
    finally:
        profile_path = Path(session.end_profiling())
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        nodes = [event for event in profile if event.get("cat") == "Node" and event.get("args", {}).get("provider")]
        providers = Counter(str(event["args"]["provider"]) for event in nodes)
        precision: dict[str, dict[str, Any]] = {}
        for event in nodes:
            args = event["args"]
            operation = str(args.get("op_name"))
            entry = precision.setdefault(operation, {"executions": 0, "inputTypes": Counter(), "outputTypes": Counter()})
            entry["executions"] += 1
            for field, target in [("input_type_shape", "inputTypes"), ("output_type_shape", "outputTypes")]:
                for value in args.get(field, []):
                    entry[target].update(value.keys())
        report["cpuProfile"] = {"path": str(profile_path.resolve()), "bytes": profile_path.stat().st_size,
                                "providerExecutions": dict(providers), "operations": precision}
        if report["samples"]:
            report["summary"] = {"samples": len(report["samples"]),
                                 "minimumCosine": min(sample["cosine"] for sample in report["samples"]),
                                 "maximumNormalizedCoordinateError": max(sample["maxNormalizedCoordinateError"] for sample in report["samples"]),
                                 "maximumScoreError": max(sample["maxScoreError"] for sample in report["samples"]),
                                 "allTopFiveOrdersUnchanged": all(sample["topFiveOrderUnchanged"] for sample in report["samples"])}
        output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        print(f"Report: {output}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", required=True, type=Path)
    parser.add_argument("--reference", type=Path, default=Path("public/fixtures/reference/manifest.json"))
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    diagnose(arguments.pack, arguments.reference, arguments.output)


if __name__ == "__main__":
    main()
