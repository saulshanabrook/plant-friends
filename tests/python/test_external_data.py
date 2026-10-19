from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort
import pytest

from tools.plant_assets.catalog import write_json_asset
from tools.plant_assets import external_data as adapter


def tiny_model() -> onnx.ModelProto:
    # Identical payloads and repeated zero bytes must not confuse offset lookup.
    graph = onnx.helper.make_graph([
        onnx.helper.make_node("Cast", ["storage"], ["weight"], to=onnx.TensorProto.FLOAT),
        onnx.helper.make_node("MatMul", ["input", "weight"], ["product"]),
        onnx.helper.make_node("Add", ["product", "bias"], ["output"]),
    ], "offset-fixture", [onnx.helper.make_tensor_value_info("input", onnx.TensorProto.FLOAT, [1, 3])],
        [onnx.helper.make_tensor_value_info("output", onnx.TensorProto.FLOAT, [1, 4])],
        initializer=[onnx.numpy_helper.from_array(np.arange(12, dtype=np.float16).reshape(3, 4), "storage"),
                     onnx.numpy_helper.from_array(np.array([1, 2, 3, 4], dtype=np.float32), "bias"),
                     onnx.numpy_helper.from_array(np.array([1, 2, 3, 4], dtype=np.float32), "duplicate")],
        value_info=[onnx.helper.make_tensor_value_info("product", onnx.TensorProto.FLOAT, [1, 4])])
    return onnx.helper.make_model(graph, opset_imports=[onnx.helper.make_opsetid("", 17)], ir_version=8,
                                  producer_name="fabricated-test-double")


def test_all_initializer_offsets_and_model_metadata_reconstruct_original_exactly(tmp_path: Path) -> None:
    original = tiny_model()
    data = original.SerializeToString()
    graph, proof = adapter.external_graph(data, hashlib.sha256(data).hexdigest(), len(data))
    restored = onnx.load_model_from_string(graph)
    assert proof["initializerCount"] == len(original.graph.initializer)
    assert list(restored.graph.node) == list(original.graph.node)
    assert restored.graph.input == original.graph.input
    assert restored.graph.output == original.graph.output
    assert restored.graph.value_info == original.graph.value_info
    assert restored.opset_import == original.opset_import
    assert restored.producer_name == original.producer_name
    assert proof["initializers"][1]["offset"] != proof["initializers"][2]["offset"]
    for before, after, descriptor in zip(original.graph.initializer, restored.graph.initializer, proof["initializers"], strict=True):
        assert descriptor["name"] == before.name == after.name
        assert descriptor["dataType"] == before.data_type == after.data_type
        assert descriptor["shape"] == list(before.dims) == list(after.dims)
        external = {entry.key: entry.value for entry in after.external_data}
        assert external == {"location": adapter.EXTERNAL_LOCATION, "offset": str(descriptor["offset"]), "length": str(descriptor["length"])}
        assert not after.HasField("raw_data")
        assert after.data_location == onnx.TensorProto.EXTERNAL
        raw = data[descriptor["offset"]:descriptor["offset"] + descriptor["length"]]
        assert raw == before.raw_data
        assert hashlib.sha256(raw).hexdigest() == descriptor["sha256"]
        after.ClearField("external_data"); after.ClearField("data_location"); after.raw_data = raw
    assert restored.SerializeToString() == data  # Entire ModelProto, not only selected fields.
    (tmp_path / adapter.EXTERNAL_LOCATION).write_bytes(data)
    path = tmp_path / "graph.onnx"
    path.write_bytes(graph)
    onnx.checker.check_model(str(path))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.log_severity_level = 3
    original_session = ort.InferenceSession(data, sess_options=options, providers=["CPUExecutionProvider"])
    external_session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
    sample = {"input": np.array([[.3, -.6, 1.2]], dtype=np.float32)}
    np.testing.assert_array_equal(original_session.run(None, sample)[0], external_session.run(None, sample)[0])


@pytest.mark.parametrize("data", [b"\x80", b"\x3a\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\x01", b"\x3a\x05\x01", b"\x3f", b"\x00"])
def test_wire_parser_rejects_truncated_overflowing_or_unsupported_fields(data: bytes) -> None:
    with pytest.raises(ValueError):
        adapter.initializer_offsets(data)


@pytest.mark.parametrize("variant", ["hash", "bytes", "duplicate name", "typed data", "mixed storage", "external", "nested", "oversized graph"])
def test_external_graph_rejects_unverified_or_unsupported_sources(variant: str, monkeypatch: pytest.MonkeyPatch) -> None:
    model = tiny_model()
    if variant == "duplicate name":
        model.graph.initializer[2].name = "bias"
    elif variant == "typed data":
        model.graph.initializer[0].ClearField("raw_data")
        model.graph.initializer[0].int32_data.extend([0] * 12)
    elif variant == "mixed storage":
        model.graph.initializer[0].int32_data.extend([0] * 12)
    elif variant == "external":
        onnx.external_data_helper.set_external_data(model.graph.initializer[0], "other.bin", 0, 24)
    elif variant == "nested":
        model.graph.node.append(onnx.helper.make_node("If", ["condition"], ["selected"], then_branch=onnx.helper.make_graph([], "nested", [], [])))
    elif variant == "oversized graph":
        monkeypatch.setattr(adapter, "MAX_GRAPH_BYTES", 1)
    data = model.SerializeToString()
    with pytest.raises(ValueError):
        adapter.external_graph(data, "0" * 64 if variant == "hash" else hashlib.sha256(data).hexdigest(), len(data) + (variant == "bytes"))


@pytest.fixture
def preparation(tmp_path: Path) -> tuple[Path, Path, Path]:
    public = tmp_path / "public"
    output = public / "packs/bioclip2"
    original = output / "source"
    original.mkdir(parents=True)
    data = tiny_model().SerializeToString()
    digest = hashlib.sha256(data).hexdigest()
    weights = output / "weights"
    weights.mkdir()
    (weights / f"{digest}.onnx").write_bytes(data)
    weight = {"url": f"../weights/{digest}.onnx", "sha256": digest, "bytes": len(data)}
    vectors = write_json_asset(original, "vectors.f32", [1, 0, 0])
    rows = write_json_asset(original, "rows.json", ["fixture"])
    runtime = {"version": "1.30.0", "files": []}
    manifest = {"schemaVersion": 1, "kind": "bioclip2", "id": "source", "name": "Fabricated test pack",
                "model": {"file": weight, "externalData": [], "precision": "FP16 matrix storage with FP32 arithmetic and input/output"},
                "vectors": {"file": vectors}, "catalog": {"rows": rows, "id": "catalog"},
                "preprocessing": {"sha256": "a" * 64}, "prompts": {"sha256": "b" * 64}, "runtime": runtime,
                "preparationIdentity": {"version": 2, "exportId": "export", "vectorId": "vectors", "fp16Recipe": {"version": "unchanged"}, "runtime": runtime},
                "files": [weight, vectors, rows]}
    write_json_asset(original, "manifest.json", manifest)
    write_json_asset(public, "model.json", {"url": "packs/bioclip2/source/manifest.json"})
    (public / "runtime").mkdir()
    write_json_asset(public / "runtime", "manifest.json", runtime)
    package = tmp_path / "runtime-package"
    (package / "dist").mkdir(parents=True)
    (package / "package.json").write_text(json.dumps({"name": "onnxruntime-web", "version": "1.30.0"}))
    for name in adapter.RUNTIME_NAMES:
        (package / "dist" / name).write_bytes(b"fabricated runtime test double: " + name.encode())
    return original / "manifest.json", package, public


def test_preparation_preserves_source_pointers_cache_descriptors_and_numerical_recipes(preparation: tuple[Path, Path, Path]) -> None:
    source_path, package, public = preparation
    source_bytes = source_path.read_bytes()
    source = json.loads(source_bytes)
    pointer = (public / "model.json").read_bytes()
    runtime_pointer = (public / "runtime/manifest.json").read_bytes()
    target = adapter.prepare_external_pack(source_path, package)
    manifest = json.loads(target.read_bytes())
    assert target != source_path
    assert source_path.read_bytes() == source_bytes
    assert (public / "model.json").read_bytes() == pointer
    assert (public / "runtime/manifest.json").read_bytes() == runtime_pointer
    assert manifest["model"]["externalData"] == [{"path": adapter.EXTERNAL_LOCATION, "file": source["model"]["file"]}]
    assert source["model"]["file"] in manifest["files"]
    assert manifest["externalDataPreparation"]["proof"] in manifest["files"]
    assert manifest["externalDataPreparation"]["sourcePackId"] == source["id"]
    proof = json.loads((target.parent / "external-data-proof.json").read_bytes())
    assert proof["sourcePackId"] == source["id"]
    assert proof["sourceManifestSha256"] == hashlib.sha256(source_bytes).hexdigest()
    assert not (target.parent / adapter.EXTERNAL_LOCATION).exists()
    assert manifest["preparationIdentity"]["exportId"] == source["preparationIdentity"]["exportId"]
    assert manifest["preparationIdentity"]["vectorId"] == source["preparationIdentity"]["vectorId"]
    assert manifest["preparationIdentity"]["fp16Recipe"] == source["preparationIdentity"]["fp16Recipe"]
    for name in ("vectors", "catalog", "preprocessing", "prompts"):
        assert manifest[name] == source[name]
    for file in [*manifest["files"], manifest["externalDataPreparation"]["proof"]]:
        path = target.parent / file["url"]
        data = path.read_bytes()
        assert len(data) == file["bytes"]
        assert hashlib.sha256(data).hexdigest() == file["sha256"]
    assert adapter.prepare_external_pack(source_path, package) == target
    (target.parent / "image.external.onnx").write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="corrupt"):
        adapter.prepare_external_pack(source_path, package)


@pytest.mark.parametrize("boundary", ["structural", "manifest"])
def test_failed_preparation_never_publishes_pack_or_changes_pointers(preparation: tuple[Path, Path, Path], monkeypatch: pytest.MonkeyPatch, boundary: str) -> None:
    source_path, package, public = preparation
    pointer = (public / "model.json").read_bytes()

    def fail(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("interrupted preparation canary")

    if boundary == "structural":
        monkeypatch.setattr(onnx.checker, "check_model", fail)
    else:
        original_write = write_json_asset

        def interrupt(directory: Path, name: str, value: object) -> dict[str, Any]:
            if name == "manifest.json":
                fail()
            return original_write(directory, name, value)

        monkeypatch.setattr(adapter, "write_json_asset", interrupt)
    with pytest.raises(RuntimeError, match="interrupted preparation canary"):
        adapter.prepare_external_pack(source_path, package)
    assert list(source_path.parent.parent.glob("*/manifest.json")) == [source_path]
    assert not list(source_path.parent.parent.glob(".*"))
    assert (public / "model.json").read_bytes() == pointer


def test_runtime_version_and_immutable_file_conflicts_fail_before_publishing(preparation: tuple[Path, Path, Path]) -> None:
    source_path, package, public = preparation
    target = public / "runtime/1.30.0" / adapter.RUNTIME_NAMES[0]
    target.parent.mkdir()
    target.write_bytes(b"conflicting immutable runtime")
    with pytest.raises(ValueError, match="conflicts"):
        adapter.prepare_external_pack(source_path, package)
    target.unlink()
    (package / "package.json").write_text(json.dumps({"name": "onnxruntime-web", "version": "1.30.1"}))
    with pytest.raises(ValueError, match="versions differ"):
        adapter.prepare_external_pack(source_path, package)
    assert list(source_path.parent.parent.glob("*/manifest.json")) == [source_path]
