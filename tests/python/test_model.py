from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort
import pytest
import torch
from open_clip.model import CLIP, _build_text_tower
from open_clip.zero_shot_metadata import OPENAI_IMAGENET_TEMPLATES

from tools.plant_assets import model as adapter
from tools.plant_assets.catalog import write_json_asset


def test_preprocessing_and_official_prompt_ensemble_identity() -> None:
    assert adapter.PREPROCESS_SHA256 == "b09f51af341c7b946e0d926d2be163141466de083009c73dcc6bbf632feb319a"
    assert adapter.PREPROCESS_SERIALIZATION == "sorted-key compact UTF-8 JSON"
    prompts = json.loads(Path(adapter.__file__).with_name("prompts.json").read_text())
    # These 80 installed OpenCLIP templates were also checked against the AST of
    # the recorded immutable pybioclip source; no network is needed for fast tests.
    assert prompts["templates"] == [template("{name}") for template in OPENAI_IMAGENET_TEMPLATES]
    assert len(prompts["templates"]) == 80
    assert hashlib.sha256(json.dumps(prompts["templates"], separators=(",", ":")).encode()).hexdigest() == adapter.PROMPT_SHA256
    assert prompts["sourceSha256"] == "68b67d27cdb7a623c15a5ccca2c71c258c5b2089b5fd37699bbd537e8a8ab42d"


class TinyTextModel(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.visual = torch.nn.Identity()


@pytest.fixture
def tiny_causal_text_model() -> Any:
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(0)
        model = _build_text_tower(768, {"context_length": 77, "vocab_size": 49408, "width": 8, "heads": 2, "layers": 2})
    model.eval().requires_grad_(False)
    model.text_pool_type = model.pool_type
    model.text_eos_id = model.eos_id
    return model


def test_prompt_vectors_match_official_recipe_and_trim_labels(tiny_causal_text_model: Any) -> None:
    observed: list[list[str]] = []

    def tokenizer(prompts: list[str]) -> torch.Tensor:
        observed.append(prompts)
        tokens = torch.zeros((len(prompts), 77), dtype=torch.int64)
        tokens[0, :3] = torch.tensor([49406, 17, 49407])
        tokens[1, :5] = torch.tensor([49406, 3, 7, 19, 49407])
        return tokens

    tiny = tiny_causal_text_model
    actual = adapter.prompt_vectors(tiny, tokenizer, ["  Salvia officinalis  ", "Malus domestica"], ["a {name}", "the {name}"], "cpu")
    # Independently use the official column-major implementation, then transpose.
    official = []
    for _ in range(2):
        with torch.inference_mode():
            text = CLIP.encode_text(tiny, tokenizer(["first", "second"]))
        normalized = torch.nn.functional.normalize(text, dim=-1).mean(dim=0)
        normalized /= normalized.norm()
        official.append(normalized)
    expected = torch.stack(official, dim=1).T.numpy()
    np.testing.assert_allclose(actual, expected, atol=1e-6, rtol=1e-6)
    assert observed[0] == ["a Salvia officinalis", "the Salvia officinalis"]
    assert actual.dtype.str == "<f4"
    assert actual.flags.c_contiguous


def test_causal_prefix_matches_full_context_and_future_tokens_cannot_change_eot(tiny_causal_text_model: Any) -> None:
    model = tiny_causal_text_model
    adapter.validate_prefix_text_model(model)
    tokens = torch.zeros((2, 77), dtype=torch.int64)
    tokens[0, :3] = torch.tensor([49406, 17, 49407])
    tokens[1, :5] = torch.tensor([49406, 3, 7, 19, 49407])
    changed_future = tokens.clone()
    changed_future[:, 6:] = 29
    with torch.inference_mode():
        full = CLIP.encode_text(model, tokens)
        prefix = adapter.encode_text_causal_prefix(model, tokens, "cpu")
        changed = CLIP.encode_text(model, changed_future)
    torch.testing.assert_close(prefix, full, atol=1e-6, rtol=1e-6)
    torch.testing.assert_close(changed, full, atol=1e-6, rtol=1e-6)


@pytest.mark.parametrize("field,value", [("text_pool_type", "last"), ("attn_mask", None),
                                        ("attn_mask", torch.zeros(77, 77)), ("cls_emb", torch.ones(8))])
def test_prefix_model_guard_rejects_noncausal_or_different_pooling(tiny_causal_text_model: Any, field: str, value: Any) -> None:
    setattr(tiny_causal_text_model, field, value)
    with pytest.raises(ValueError, match="causal"):
        adapter.validate_prefix_text_model(tiny_causal_text_model)


def test_prefix_model_guard_rejects_precision_change(tiny_causal_text_model: Any) -> None:
    tiny_causal_text_model.half()
    with pytest.raises(ValueError, match="FP32"):
        adapter.validate_prefix_text_model(tiny_causal_text_model)


@pytest.mark.parametrize("invalid", ["missing_eot", "duplicate_eot", "content_after_eot", "wrong_dtype"])
def test_prefix_token_guard_never_discards_unverified_content(tiny_causal_text_model: Any, invalid: str) -> None:
    tokens = torch.zeros((1, 77), dtype=torch.int64)
    tokens[0, :3] = torch.tensor([49406, 17, 49407])
    if invalid == "missing_eot":
        tokens[0, 2] = 0
    elif invalid == "duplicate_eot":
        tokens[0, 4] = 49407
    elif invalid == "content_after_eot":
        tokens[0, 4] = 19
    else:
        tokens = tokens.float()
    with pytest.raises(ValueError, match="EOT|padding|int64"):
        adapter.encode_text_causal_prefix(tiny_causal_text_model, tokens, "cpu")


@pytest.mark.parametrize("values,rows,error", [
    (np.zeros((1, 768), dtype="<f4"), 1, "unit"),
    (np.full((1, 768), np.nan, dtype="<f4"), 1, "finite"),
    (np.ones((1, 767), dtype="<f4"), 1, "byte count"),
    (np.ones((1, 768), dtype="<f4"), 2, "byte count"),
])
def test_invalid_or_partial_vector_cache_is_rejected(tmp_path: Path, values: Any, rows: int, error: str) -> None:
    path = tmp_path / "vectors.f32"
    values.tofile(path)
    with pytest.raises(ValueError, match=error):
        adapter.validate_vectors(path, rows)


def test_cache_requires_matching_recipe_and_content_receipt(tmp_path: Path) -> None:
    path = tmp_path / "image.fp32.onnx"
    path.write_bytes(b"fully written bytes")
    recipe = {"revision": adapter.MODEL_REVISION, "opset": 17}
    assert not adapter.cached_artifact(path, recipe)
    write_json_asset(tmp_path, "image.fp32.json", {"recipe": recipe, "file": adapter.describe_file(path)})
    assert adapter.cached_artifact(path, recipe)
    assert not adapter.cached_artifact(path, {**recipe, "opset": 18})
    path.write_bytes(b"interrupted")
    assert not adapter.cached_artifact(path, recipe)


def tiny_encoder(path: str | Path) -> None:
    graph = onnx.helper.make_graph([
        onnx.helper.make_node("Conv", ["images", "convolution"], ["features"], name="convolution"),
        onnx.helper.make_node("GlobalAveragePool", ["features"], ["pooled"], name="pool"),
        onnx.helper.make_node("Flatten", ["pooled"], ["flat"], axis=1, name="flatten"),
        onnx.helper.make_node("MatMul", ["flat", "projection"], ["embedding"], name="projection"),
    ], "tiny-test-double", [onnx.helper.make_tensor_value_info("images", onnx.TensorProto.FLOAT, [1, 3, 224, 224])],
        [onnx.helper.make_tensor_value_info("embedding", onnx.TensorProto.FLOAT, [1, 768])],
        initializer=[onnx.numpy_helper.from_array(np.tile(np.array([0.25, 0.5, 0.75], dtype=np.float32), (8, 1)).reshape(8, 3, 1, 1), "convolution"),
                     onnx.numpy_helper.from_array(np.linspace(0.1, 0.9, 8 * 768, dtype=np.float32).reshape(8, 768), "projection")],
        value_info=[onnx.helper.make_tensor_value_info("features", onnx.TensorProto.FLOAT, [1, 8, 224, 224]),
                    onnx.helper.make_tensor_value_info("pooled", onnx.TensorProto.FLOAT, [1, 8, 1, 1]),
                    onnx.helper.make_tensor_value_info("flat", onnx.TensorProto.FLOAT, [1, 8])])
    graph_model = onnx.helper.make_model(graph, opset_imports=[onnx.helper.make_opsetid("", 17)], ir_version=10)
    onnx.save(graph_model, path)


def test_onnx_contract_requires_actual_projected_shape(tmp_path: Path) -> None:
    path = tmp_path / "encoder.onnx"
    tiny_encoder(path)
    adapter.validate_onnx(path)
    graph = onnx.load(path)
    graph.graph.output[0].type.tensor_type.shape.dim[1].dim_value = 1024
    onnx.save(graph, path)
    with pytest.raises(ValueError, match="type or shape"):
        adapter.validate_onnx(path)


@pytest.fixture
def preparation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, list[str]]:
    monkeypatch.chdir(tmp_path)
    catalog_dir = tmp_path / "public/packs/pfaf/catalog-test"
    catalog_dir.mkdir(parents=True)
    rows = [{"id": f"pfaf:label{i}", "scientificName": f"label{i}"} for i in range(6)]
    index = write_json_asset(catalog_dir, "index.json", rows)
    write_json_asset(catalog_dir, "manifest.json", {"id": "catalog-test", "taxonCount": len(rows), "sourceSha256": "a" * 64,
                                                  "indexFile": "index.json", "files": [index]})
    runtime = tmp_path / "public/runtime/1.0.0"
    runtime.mkdir(parents=True)
    (runtime / "test.wasm").write_bytes(b"local runtime test double")
    write_json_asset(runtime.parent, "manifest.json", {"version": "1.0.0", "files": [adapter.describe_file(runtime / "test.wasm", "1.0.0/test.wasm")]})
    monkeypatch.setattr(adapter, "load_checkpoint", lambda revision: (TinyTextModel(), None, None))
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)
    calls: list[str] = []

    def export(*args: Any, **kwargs: Any) -> None:
        assert not torch.backends.mha.get_fastpath_enabled()
        calls.append("export")
        tiny_encoder(args[2])

    def vectorize(model: Any, tokenizer: Any, names: list[str], templates: list[str], device: str) -> Any:
        calls.append("vectors")
        vectors = np.zeros((len(names), 768), dtype="<f4")
        vectors[:, 0] = 1
        return vectors

    monkeypatch.setattr(torch.onnx, "export", export)
    monkeypatch.setattr(adapter, "prompt_vectors", vectorize)
    return catalog_dir / "manifest.json", tmp_path / "public/packs/bioclip2", calls


def test_preparation_publishes_verified_files_and_reuses_independent_caches(preparation: tuple[Path, Path, list[str]]) -> None:
    catalog, output, calls = preparation
    path = adapter.prepare_model(catalog, adapter.MODEL_REVISION, output, limit=5)
    manifest = json.loads(path.read_text())
    assert calls == ["vectors", "export"]
    for file in manifest["files"]:
        assert adapter.describe_file(path.parent / file["url"], file["url"]) == file
    assert manifest["preprocessing"]["sha256"] == adapter.PREPROCESS_SHA256
    assert manifest["runtime"]["files"][0]["url"] == "../../../runtime/1.0.0/test.wasm"
    assert manifest["model"]["externalData"] == []
    assert manifest["model"]["precision"] == "FP16 matrix storage with FP32 arithmetic and input/output"
    assert manifest["vectorPreparation"]["textContext"] == adapter.TEXT_CONTEXT_POLICY
    assert manifest["vectorPreparation"]["recipe"] == adapter.VECTOR_VERSION
    stored = onnx.load(path.parent / manifest["model"]["file"]["url"])
    assert [weight.data_type for weight in stored.graph.initializer] == [onnx.TensorProto.FLOAT, onnx.TensorProto.FLOAT16]
    assert stored.graph.node[0].op_type == "Cast"
    assert stored.graph.node[0].output == ["projection"]
    assert stored.graph.node[0].attribute[0].i == onnx.TensorProto.FLOAT
    assert adapter.prepare_model(catalog, adapter.MODEL_REVISION, output, limit=5) == path
    assert calls == ["vectors", "export"]
    # The full catalog has different vector and pack identities but reuses image weights.
    full_path = adapter.prepare_model(catalog, adapter.MODEL_REVISION, output)
    assert full_path != path
    full = json.loads(full_path.read_text())
    assert full["model"]["file"] == manifest["model"]["file"]
    assert calls == ["vectors", "export", "vectors"]
    # A runtime build change changes pack identity, while reusing both model/vector caches.
    runtime_manifest = Path("public/runtime/manifest.json")
    runtime = json.loads(runtime_manifest.read_text())
    runtime["version"] = "1.0.1"
    write_json_asset(runtime_manifest.parent, runtime_manifest.name, runtime)
    changed = adapter.prepare_model(catalog, adapter.MODEL_REVISION, output)
    assert changed != full_path
    assert calls == ["vectors", "export", "vectors"]
    # Equal row counts cannot hide a different text-vector order.
    index_path = catalog.parent / "index.json"
    ordered_rows = json.loads(index_path.read_text())
    index_asset = write_json_asset(catalog.parent, "index.json", list(reversed(ordered_rows)))
    catalog_manifest = json.loads(catalog.read_text())
    catalog_manifest["files"] = [index_asset]
    write_json_asset(catalog.parent, "manifest.json", catalog_manifest)
    reordered_path = adapter.prepare_model(catalog, adapter.MODEL_REVISION, output)
    assert reordered_path != changed
    assert calls == ["vectors", "export", "vectors", "vectors"]
    reordered = json.loads(reordered_path.read_text())
    assert json.loads((reordered_path.parent / "rows.json").read_text()) == [r["id"] for r in reversed(ordered_rows)]
    assert reordered["model"]["file"] == manifest["model"]["file"]


def test_text_context_recipe_change_rebuilds_vectors_only_and_preserves_old_pack(preparation: tuple[Path, Path, list[str]], monkeypatch: pytest.MonkeyPatch) -> None:
    catalog, output, calls = preparation
    original_path = adapter.prepare_model(catalog, adapter.MODEL_REVISION, output, limit=5)
    original_bytes = original_path.read_bytes()
    original = json.loads(original_bytes)
    monkeypatch.setattr(adapter, "TEXT_CONTEXT_POLICY", {**adapter.TEXT_CONTEXT_POLICY, "prefix": "different recipe policy"})
    changed_path = adapter.prepare_model(catalog, adapter.MODEL_REVISION, output, limit=5)
    changed = json.loads(changed_path.read_text())
    assert calls == ["vectors", "export", "vectors"]
    assert changed_path != original_path
    assert changed["model"]["file"] == original["model"]["file"]
    assert changed["reference"] == original["reference"]
    assert original_path.read_bytes() == original_bytes


def test_storage_recipe_change_reuses_fp32_and_vectors_and_preserves_old_public_pack(preparation: tuple[Path, Path, list[str]], monkeypatch: pytest.MonkeyPatch) -> None:
    catalog, output, calls = preparation
    original_path = adapter.prepare_model(catalog, adapter.MODEL_REVISION, output, limit=5)
    original_manifest_bytes = original_path.read_bytes()
    original = json.loads(original_manifest_bytes)
    original_weights_path = original_path.parent / original["model"]["file"]["url"]
    original_weights = original_weights_path.read_bytes()
    monkeypatch.setattr(adapter, "MINIMUM_ELEMENTS", 8192)
    changed_path = adapter.prepare_model(catalog, adapter.MODEL_REVISION, output, limit=5)
    changed = json.loads(changed_path.read_text())
    assert changed_path != original_path
    assert changed["model"]["file"] != original["model"]["file"]
    assert changed["reference"] == original["reference"]
    assert changed["vectors"] == original["vectors"]
    assert calls == ["vectors", "export"]
    assert original_path.read_bytes() == original_manifest_bytes
    assert original_weights_path.read_bytes() == original_weights
    recipe = changed["preparationIdentity"]["fp16Recipe"]
    assert recipe["version"] == "fp16-matrix-storage-fp32-arithmetic-v1"
    assert recipe["minimumRank"] == 2
    assert recipe["minimumElements"] == 8192
    assert recipe["arithmeticType"] == recipe["inputOutputType"] == "float32"


def test_interrupted_export_does_not_publish_pack_or_poison_retry(preparation: tuple[Path, Path, list[str]], monkeypatch: pytest.MonkeyPatch) -> None:
    catalog, output, calls = preparation

    def broken(*args: Any, **kwargs: Any) -> None:
        assert not torch.backends.mha.get_fastpath_enabled()
        Path(args[2]).write_bytes(b"truncated ONNX")
        raise RuntimeError("simulated export interruption")

    monkeypatch.setattr(torch.onnx, "export", broken)
    with pytest.raises(RuntimeError, match="interruption"):
        adapter.prepare_model(catalog, adapter.MODEL_REVISION, output, limit=5)
    assert not list(output.glob("*/manifest.json"))
    assert not Path("public/model.json").exists()
    assert not list(Path(".cache/exports").glob("*/*.onnx"))
    monkeypatch.setattr(torch.onnx, "export", lambda *args, **kwargs: tiny_encoder(args[2]))
    path = adapter.prepare_model(catalog, adapter.MODEL_REVISION, output, limit=5)
    assert path.is_file()
    assert calls == ["vectors"]


def test_unsupported_revision_is_rejected_before_any_download(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="immutable"):
        adapter.prepare_model(tmp_path / "missing.json", "main", tmp_path)


@pytest.mark.parametrize("enabled", [True, False])
def test_attention_export_context_restores_prior_state_on_success_and_failure(enabled: bool) -> None:
    original = torch.backends.mha.get_fastpath_enabled()
    try:
        torch.backends.mha.set_fastpath_enabled(enabled)
        with adapter.exportable_attention():
            assert not torch.backends.mha.get_fastpath_enabled()
        assert torch.backends.mha.get_fastpath_enabled() == enabled
        with pytest.raises(RuntimeError, match="export failure"):
            with adapter.exportable_attention():
                assert not torch.backends.mha.get_fastpath_enabled()
                raise RuntimeError("simulated export failure")
        assert torch.backends.mha.get_fastpath_enabled() == enabled
    finally:
        torch.backends.mha.set_fastpath_enabled(original)


class TinyAttention(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.attention = torch.nn.MultiheadAttention(8, 2, batch_first=True)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        result: torch.Tensor = self.attention(inputs, inputs, inputs, need_weights=False)[0]
        return result


def test_actual_attention_export_runs_opset17_and_matches_pytorch(tmp_path: Path) -> None:
    module = TinyAttention().eval().requires_grad_(False)
    inputs = torch.randn(1, 3, 8)
    path = tmp_path / "attention.onnx"
    original = torch.backends.mha.get_fastpath_enabled()
    with torch.inference_mode():
        expected = module(inputs).numpy()
        with adapter.exportable_attention():
            torch.onnx.export(module, (inputs,), path, input_names=["inputs"], output_names=["output"],
                              opset_version=17, dynamo=False, external_data=False)
    assert torch.backends.mha.get_fastpath_enabled() == original
    onnx.checker.check_model(str(path))
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    actual = session.run(["output"], {"inputs": inputs.numpy()})[0]
    np.testing.assert_allclose(actual, expected, atol=1e-6, rtol=1e-5)
