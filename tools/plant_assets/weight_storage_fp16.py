"""FP16 weight storage with the original FP32 encoder arithmetic.

Production preparation imports the converter. The standalone CLI accepts cached
ONNX inputs and writes an unactivated experiment without preparing other assets.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.metadata
import json
import os
import time
from pathlib import Path
from typing import Any

import numpy as np
import onnx

MINIMUM_ELEMENTS = 4096
MINIMUM_RANK = 2
STORAGE_RECIPE = "fp16-matrix-storage-fp32-arithmetic-v1"
PRESERVED_WEIGHTS_POLICY = "Preserve all rank-zero/rank-one scalars, biases, normalization weights, and all small tensors in FP32"


def quantize_weight_storage(model: onnx.ModelProto, minimum_elements: int = MINIMUM_ELEMENTS) -> dict[str, Any]:
    """Rename large FP32 matrix/tensor storage and restore its FP32 value by Cast.

    Every original node, I/O declaration, and value_info is preserved. Casts
    depend only on initializers and are prepended, making the graph topologically
    sorted by construction without changing the order of original nodes.
    """
    if minimum_elements < 1:
        raise ValueError("The storage threshold must be positive")
    selected: list[dict[str, Any]] = []
    preserved = 0
    source_nodes = hashlib.sha256()
    queue = [model.graph]
    graphs = []
    while queue:
        graph = queue.pop(0)
        graphs.append(graph)
        for node in graph.node:
            encoded = node.SerializeToString()
            source_nodes.update(len(encoded).to_bytes(8, "little"))
            source_nodes.update(encoded)
            for attribute in node.attribute:
                if attribute.type == onnx.AttributeProto.GRAPH:
                    queue.append(attribute.g)
                elif attribute.type == onnx.AttributeProto.GRAPHS:
                    queue.extend(attribute.graphs)
    # Rebuilding a parent node list copies its subgraphs. Convert children first
    # so those copies contain the converted storage rather than detached graphs.
    for graph in reversed(graphs):
        original_nodes = list(graph.node)
        names = {value.name for value in [*graph.input, *graph.output, *graph.value_info, *graph.initializer]}
        names.update(name for node in original_nodes for name in [*node.input, *node.output])
        graph_inputs = {value.name for value in graph.input}
        casts = []
        for weight in graph.initializer:
            count = int(np.prod(weight.dims, dtype=np.int64))
            if weight.data_type != onnx.TensorProto.FLOAT or len(weight.dims) < MINIMUM_RANK or count < minimum_elements:
                preserved += 1
                continue
            original_name = weight.name
            storage_name = original_name + "__fp16_storage"
            if storage_name in names or original_name in graph_inputs:
                raise ValueError(f"Cannot preserve weight name/I/O contract for {original_name!r}")
            values = onnx.numpy_helper.to_array(weight)
            if not np.isfinite(values).all():
                raise ValueError(f"Non-finite source weight: {original_name}")
            with np.errstate(over="ignore", invalid="ignore"):
                quantized = values.astype(np.float16)
            if not np.isfinite(quantized).all():
                raise ValueError(f"Weight cannot be stored as finite FP16: {original_name}")
            maximum_error = float(np.max(np.abs(values - quantized.astype(np.float32))))
            underflowed = int(np.count_nonzero((values != 0) & (quantized == 0)))
            shape = list(weight.dims)
            weight.CopyFrom(onnx.numpy_helper.from_array(quantized, name=storage_name))
            casts.append(onnx.helper.make_node("Cast", [storage_name], [original_name],
                                               to=onnx.TensorProto.FLOAT, name=storage_name + "_to_fp32"))
            names.add(storage_name)
            selected.append({"name": original_name, "storageName": storage_name, "shape": shape, "elements": count,
                             "maximumWeightError": maximum_error, "underflowedValues": underflowed})
        if casts:
            graph.ClearField("node")
            graph.node.extend(casts)
            graph.node.extend(original_nodes)
    return {
        "recipe": STORAGE_RECIPE, "minimumElements": minimum_elements, "minimumRank": MINIMUM_RANK,
        "policy": "FP16 storage only for finite FLOAT initializers with rank>=2 and elements>=threshold; Cast back to FP32 before unchanged original nodes",
        "criticalWeightsPolicy": PRESERVED_WEIGHTS_POLICY,
        "originalNodesSha256": source_nodes.hexdigest(), "selectedInitializers": len(selected), "preservedInitializers": preserved,
        "selectedElements": sum(weight["elements"] for weight in selected),
        "maximumWeightError": max((weight["maximumWeightError"] for weight in selected), default=0),
        "underflowedValues": sum(weight["underflowedValues"] for weight in selected), "weights": selected,
        "arithmetic": "Original FP32 operators, I/O, and value_info; FP16 is storage only; runtime optimizations must be checked separately",
    }


def prepare_experiment(source: Path, expected_sha256: str, output: Path, minimum_elements: int = MINIMUM_ELEMENTS) -> Path:
    started = time.perf_counter()
    with source.open("rb") as file:
        source_hash = hashlib.file_digest(file, "sha256").hexdigest()
    if source_hash != expected_sha256:
        raise ValueError("Cached FP32 source integrity failed")
    source_bytes = source.stat().st_size
    model = onnx.load(source, load_external_data=False)
    onnx.checker.check_model(str(source))
    if any(weight.data_location == onnx.TensorProto.EXTERNAL for weight in model.graph.initializer):
        raise ValueError("The experiment expects a self-contained cached FP32 source")
    source_io = {"inputs": [value.SerializeToString() for value in model.graph.input],
                 "outputs": [value.SerializeToString() for value in model.graph.output],
                 "valueInfo": [value.SerializeToString() for value in model.graph.value_info]}
    summary = quantize_weight_storage(model, minimum_elements)
    if source_io != {"inputs": [value.SerializeToString() for value in model.graph.input],
                     "outputs": [value.SerializeToString() for value in model.graph.output],
                     "valueInfo": [value.SerializeToString() for value in model.graph.value_info]}:
        raise ValueError("The conversion changed the FP32 graph type contract")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".partial")
    try:
        onnx.save(model, temporary)
        del model
        gc.collect()
        onnx.checker.check_model(str(temporary))
        with temporary.open("rb") as file:
            candidate_hash = hashlib.file_digest(file, "sha256").hexdigest()
        candidate_bytes = temporary.stat().st_size
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    descriptor = {
        "schemaVersion": 1, "kind": "experimental-weight-storage", "activated": False,
        "source": {"path": str(source.resolve()), "bytes": source_bytes, "sha256": source_hash},
        "candidate": {"path": str(output.resolve()), "bytes": candidate_bytes, "sha256": candidate_hash},
        "conversion": summary, "versions": {name: importlib.metadata.version(name) for name in ("onnx", "numpy")},
        "elapsedSeconds": time.perf_counter() - started,
        "status": "ONNX structure verified; actual browser numerical gates remain required; no tolerances changed",
    }
    descriptor_path = output.with_suffix(".json")
    descriptor_path.write_text(json.dumps(descriptor, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "descriptor": str(descriptor_path), "bytes": candidate_bytes,
                      "sha256": candidate_hash, "selectedInitializers": summary["selectedInitializers"],
                      "elapsedSeconds": descriptor["elapsedSeconds"]}), flush=True)
    return descriptor_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--minimum-elements", default=MINIMUM_ELEMENTS, type=int)
    arguments = parser.parse_args()
    prepare_experiment(arguments.source, arguments.expected_sha256, arguments.output, arguments.minimum_elements)


if __name__ == "__main__":
    main()
