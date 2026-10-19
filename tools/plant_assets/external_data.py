"""Stage an exact-weight JSPI pack using offsets into its existing ONNX asset.

This does not load a checkpoint, run an exporter, recompute vectors, activate a
pointer, or rewrite the original model. Only initializer storage descriptors in
the small graph change; the original content-addressed ONNX remains the blob.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import onnx

from .catalog import write_json_asset

EXTERNAL_RECIPE = "bioclip2-original-onnx-external-view-v2"
EXTERNAL_LOCATION = "weights.onnx"
MAX_GRAPH_BYTES = 16 * 1024 * 1024
RUNTIME_NAMES = ("ort-wasm-simd-threaded.jspi.mjs", "ort-wasm-simd-threaded.jspi.wasm")


def _varint(data: bytes, position: int, end: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        if position >= end:
            raise ValueError("Truncated protobuf varint")
        byte = data[position]
        position += 1
        value |= (byte & 127) << shift
        if byte < 128:
            if shift == 63 and byte > 1:
                raise ValueError("Overflowing protobuf varint")
            return value, position
    raise ValueError("Overflowing protobuf varint")


def _fields(data: bytes, start: int, end: int) -> Iterator[tuple[int, int, int, int]]:
    """Walk bounded protobuf fields without interpreting/skipping raw payloads by value."""
    position = start
    while position < end:
        tag, position = _varint(data, position, end)
        number, wire = tag >> 3, tag & 7
        if not 0 < number < 1 << 29:
            raise ValueError("Invalid protobuf field number")
        if wire == 0:
            begin = position
            _, position = _varint(data, position, end)
        elif wire in (1, 5):
            begin = position
            position += 8 if wire == 1 else 4
        elif wire == 2:
            length, position = _varint(data, position, end)
            begin = position
            position += length
        else:
            raise ValueError("Unsupported protobuf wire type")
        if position > end:
            raise ValueError("Truncated protobuf field")
        yield number, wire, begin, position


def initializer_offsets(data: bytes) -> dict[str, tuple[int, int]]:
    """Locate each top-level TensorProto.raw_data in the original wire bytes.

    Parse field tags/lengths rather than searching for payload byte patterns:
    identical tensors and repeated byte sequences must retain distinct offsets.
    """
    graphs = [(start, end) for number, wire, start, end in _fields(data, 0, len(data)) if number == 7 and wire == 2]
    if len(graphs) != 1:
        raise ValueError("Expected one encoded ONNX graph")
    offsets = {}
    for number, wire, start, end in _fields(data, *graphs[0]):
        if number != 5 or wire != 2:
            continue
        names, payloads = [], []
        for number, wire, begin, finish in _fields(data, start, end):
            if number == 8 and wire == 2:
                names.append(data[begin:finish].decode("utf-8"))
            if number == 9 and wire == 2:
                payloads.append((begin, finish - begin))
        if len(names) != 1 or not names[0] or names[0] in offsets or len(payloads) != 1 or payloads[0][1] < 1:
            raise ValueError("Every initializer needs a unique name and one nonempty raw_data payload")
        offsets[names[0]] = payloads[0]
    if not offsets:
        raise ValueError("The encoder contains no raw initializers")
    return offsets


def external_graph(data: bytes, expected_sha256: str, expected_bytes: int) -> tuple[bytes, dict[str, Any]]:
    """Verify exact raw slices and prove everything except storage is unchanged."""
    if len(data) != expected_bytes or hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError("The original ONNX integrity check failed")
    offsets = initializer_offsets(data)
    model = onnx.load_model_from_string(data)
    if model.graph.sparse_initializer or any(attribute.type in (onnx.AttributeProto.GRAPH, onnx.AttributeProto.GRAPHS)
                                             for node in model.graph.node for attribute in node.attribute):
        raise ValueError("This encoder recipe requires dense top-level initializers without nested graphs")
    if len(model.graph.initializer) != len(offsets):
        raise ValueError("Encoded and parsed initializer counts differ")
    # Keep only tiny initializer metadata copies, not another model-sized set
    # of raw payloads. Payload equality is checked against the original bytes.
    originals, slices = [], []
    source_view = memoryview(data)
    for tensor in model.graph.initializer:
        if tensor.data_location == onnx.TensorProto.EXTERNAL or tensor.external_data:
            raise ValueError("The source encoder must be self-contained")
        if tensor.float_data or tensor.int32_data or tensor.string_data or tensor.int64_data or tensor.double_data or tensor.uint64_data:
            raise ValueError("Mixed raw and typed initializer storage is unsupported")
        offset, length = offsets[tensor.name]
        raw = tensor.raw_data
        if source_view[offset:offset + length] != raw:
            raise ValueError(f"Raw initializer offset differs for {tensor.name}")
        slices.append({"name": tensor.name, "dataType": tensor.data_type, "shape": list(tensor.dims),
                       "offset": offset, "length": length, "sha256": hashlib.sha256(raw).hexdigest()})
        tensor.ClearField("raw_data")
        originals.append(tensor.SerializeToString())
    metadata_source = hashlib.sha256(model.SerializeToString()).hexdigest()
    for tensor, row in zip(model.graph.initializer, slices, strict=True):
        tensor.raw_data = b""  # set_external_data requires the field's presence.
        offset, length = row["offset"], row["length"]
        onnx.external_data_helper.set_external_data(tensor, EXTERNAL_LOCATION, offset=offset, length=length)
        tensor.ClearField("raw_data")
    graph = model.SerializeToString()
    if len(graph) > MAX_GRAPH_BYTES:
        raise ValueError("The external-data graph exceeds the bounded graph size")
    for tensor, original in zip(model.graph.initializer, originals, strict=True):
        tensor.ParseFromString(original)
    if hashlib.sha256(model.SerializeToString()).hexdigest() != metadata_source:
        raise ValueError("Externalization changed the numerical graph")
    proof = {"recipe": EXTERNAL_RECIPE, "location": EXTERNAL_LOCATION, "sourceSha256": expected_sha256,
             "sourceBytes": expected_bytes, "graphSha256": hashlib.sha256(graph).hexdigest(), "graphBytes": len(graph),
             "originalGraphAndTensorMetadataSha256": metadata_source, "restoredGraphAndTensorMetadataSha256": metadata_source,
             "initializerCount": len(slices), "initializerBytes": sum(row["length"] for row in slices),
             "largestInitializerBytes": max(row["length"] for row in slices), "initializers": slices,
             "invariant": "Original raw payloads equal their source slices; restoring original initializer metadata yields the same weight-stripped ModelProto, including all operators, attributes, types, I/O, and metadata"}
    return graph, proof


def _describe(path: Path, url: str) -> dict[str, Any]:
    with path.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    return {"url": url, "bytes": path.stat().st_size, "sha256": digest}


def _runtime(package: Path, destination: Path, expected_version: str) -> dict[str, Any]:
    """Copy only the installed matching JSPI pair, preserving existing artifacts."""
    metadata = json.loads((package / "package.json").read_text())
    if metadata["name"] != "onnxruntime-web" or metadata["version"] != expected_version:
        raise ValueError("Installed runtime and source pack versions differ")
    directory = destination / expected_version
    directory.mkdir(parents=True, exist_ok=True)
    files = []
    for name in RUNTIME_NAMES:
        source = package / "dist" / name
        descriptor = _describe(source, f"{expected_version}/{name}")
        target = directory / name
        if target.exists():
            if _describe(target, descriptor["url"]) != descriptor:
                raise ValueError("An immutable JSPI runtime file conflicts with the installed package")
        else:
            temporary = directory / f".{name}.partial"
            try:
                shutil.copyfile(source, temporary)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        files.append(descriptor)
    return {"version": expected_version, "files": files}


def prepare_external_pack(source_manifest: Path, runtime_package: Path) -> Path:
    """Publish a new immutable derived pack; never change model/runtime pointers."""
    source_manifest = source_manifest.resolve()
    source_manifest_bytes = source_manifest.read_bytes()
    source = json.loads(source_manifest_bytes)
    if source["kind"] != "bioclip2" or source["id"] != source_manifest.parent.name or source["model"].get("externalData"):
        raise ValueError("An existing immutable self-contained BioCLIP pack is required")
    weight = source["model"]["file"]
    if weight["url"] != f"../weights/{weight['sha256']}.onnx" or weight not in source["files"]:
        raise ValueError("The source encoder must be its existing shared content-addressed ONNX asset")
    output = source_manifest.parent.parent
    runtime = _runtime(runtime_package, output.parent.parent / "runtime", source["runtime"]["version"])
    recipe = {"version": EXTERNAL_RECIPE, "sourcePackId": source["id"], "sourceSha256": weight["sha256"],
              "sourceManifestSha256": hashlib.sha256(source_manifest_bytes).hexdigest(),
              "sourceBytes": weight["bytes"], "location": EXTERNAL_LOCATION, "proofFile": "external-data-proof.json"}
    identity = {**source["preparationIdentity"], "version": 3, "runtime": runtime, "externalDataRecipe": recipe}
    identifier = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:20]
    target = output / identifier
    if target.exists():
        previous = json.loads((target / "manifest.json").read_text())
        if previous["preparationIdentity"] != identity:
            raise ValueError("An immutable derived pack has a conflicting identity")
        for file in previous["files"]:
            if _describe(target / file["url"], file["url"]) != file:
                raise ValueError("An immutable derived pack is corrupt")
        return target / "manifest.json"
    source_weights = source_manifest.parent / weight["url"]
    # Check original operator/type consistency. The exact reconstruction proof
    # below preserves that result. The native file checker rejects hardlinked
    # external data, while this browser format intentionally reuses such bytes.
    onnx.checker.check_model(str(source_weights))
    data = source_weights.read_bytes()
    graph, proof = external_graph(data, weight["sha256"], weight["bytes"])
    proof.update({"sourcePackId": source["id"], "sourceManifestSha256": recipe["sourceManifestSha256"]})
    del data
    staging = Path(tempfile.mkdtemp(prefix=f".{identifier}.", dir=output))
    try:
        graph_path = staging / "image.external.onnx"
        graph_path.write_bytes(graph)
        manifest = copy.deepcopy(source)
        graph_file = _describe(graph_path, graph_path.name)
        runtime_files = [{**file, "url": "../../../runtime/" + file["url"]} for file in runtime["files"]]
        retained = [source["vectors"]["file"], source["catalog"]["rows"]]
        for file in retained:
            if Path(file["url"]).name != file["url"] or file not in source["files"]:
                raise ValueError("Vector and row assets must be immutable pack-local files")
            original = source_manifest.parent / file["url"]
            if _describe(original, file["url"]) != file:
                raise ValueError("Source vector or row integrity failed")
            os.link(original, staging / file["url"])
        proof_file = write_json_asset(staging, recipe["proofFile"], proof)
        manifest.update({"id": identifier, "preparationIdentity": identity,
                         "runtime": {"version": runtime["version"], "files": runtime_files},
                         "files": [graph_file, weight, *retained, *runtime_files, proof_file],
                         "externalDataPreparation": {"recipe": recipe, "proof": proof_file, "sourcePackId": source["id"],
                                                     "initializerCount": proof["initializerCount"],
                                                     "initializerBytes": proof["initializerBytes"],
                                                     "largestInitializerBytes": proof["largestInitializerBytes"]}})
        manifest["model"].update({"file": graph_file, "externalData": [{"path": EXTERNAL_LOCATION, "file": weight}]})
        write_json_asset(staging, "manifest.json", manifest)
        os.replace(staging, target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return target / "manifest.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--runtime-package", type=Path, default=Path("node_modules/onnxruntime-web"))
    arguments = parser.parse_args()
    print(prepare_external_pack(arguments.source_manifest, arguments.runtime_package))


if __name__ == "__main__":
    main()
