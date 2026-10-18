"""Full BioCLIP 2 export, scientific-name vectors, and a pinned asset contract."""

from __future__ import annotations

import gc
import hashlib
import importlib.metadata
import json
import os
import shutil
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import open_clip
import torch
from huggingface_hub import snapshot_download
from numpy.typing import NDArray
from open_clip.transformer import text_global_pool

from .catalog import write_json_asset
from .weight_storage_fp16 import MINIMUM_ELEMENTS, MINIMUM_RANK, PRESERVED_WEIGHTS_POLICY, STORAGE_RECIPE, quantize_weight_storage

MODEL_REPO = "imageomics/bioclip-2"
MODEL_REVISION = "2957b322090f9cb17ae72c71981c7218a28d81e0"
CHECKPOINT_SHA256 = "b7b2bf6fbc95799e42630e394cf95803892ab447c1a8ab629dbc82fbeaf7dfef"
CONFIG_SHA256 = "1bf947e96e943fe50efd5c3e26c37f843a2fa3c358967719a68c8a6d17ce68c8"
PROMPT_SHA256 = "1ca847c6a7b08b97797e593a6361d1a69ae81f9c7130e2bd01472e0538824139"
EXPORT_VERSION = "bioclip2-image-opset17-v3-unfused-mha"
VECTOR_VERSION = "pybioclip-custom-labels-causal-prefix-f32-v2"
TEXT_CONTEXT_POLICY = {
    "contextLength": 77, "endOfTextTokenId": 49407, "padTokenId": 0,
    "prefix": "retain through the maximum EOT position in each complete 80-template batch",
    "attention": "pinned strictly causal mask and original positional-embedding prefix",
    "pooling": "highest-token-ID EOT", "precision": "FP32",
}
PREPROCESS = {
    "size": 224, "orientation": "EXIF transpose once", "color": "RGB; decoded channels interpreted as sRGB; embedded ICC ignored",
    "alpha": "composite on white before resizing", "resize": "shortest-side to 224; floor other side",
    "interpolation": "Pillow bicubic antialias; a=-0.5; 22-bit coefficients; uint8 between passes",
    "crop": "224 center crop; Python round-to-even offsets", "scale": "uint8 / 255",
    "layout": "NCHW", "mean": [0.48145466, 0.4578275, 0.40821073],
    "std": [0.26862954, 0.26130258, 0.27577711],
}
# Metadata is deliberately outside the policy object hashed here.
PREPROCESS_SERIALIZATION = "sorted-key compact UTF-8 JSON"
PREPROCESS_SHA256 = hashlib.sha256(json.dumps(PREPROCESS, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


class ImageEncoder(torch.nn.Module):
    def __init__(self, visual: torch.nn.Module) -> None:
        super().__init__()
        self.visual = visual

    def forward(self, images: torch.Tensor) -> torch.Tensor:
        # visual includes the learned projection; scores normalize its FP32 output.
        result: torch.Tensor = self.visual(images)
        return result.float()


@contextmanager
def exportable_attention() -> Iterator[None]:
    """Keep legacy ONNX tracing on supported attention operations, then restore.

    Eval/inference can fuse MultiheadAttention into aten::_native_multi_head_attention,
    which the opset-17 legacy exporter cannot lower. Disabling that optimization
    preserves every attention layer and its parameters.
    """
    previous = torch.backends.mha.get_fastpath_enabled()
    torch.backends.mha.set_fastpath_enabled(False)
    try:
        yield
    finally:
        torch.backends.mha.set_fastpath_enabled(previous)


def describe_file(path: Path, url: str | None = None) -> dict[str, Any]:
    """Hash the actual file bytes without buffering a full encoder in memory."""
    with path.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    return {"url": path.name if url is None else url, "sha256": digest, "bytes": path.stat().st_size}


def validate_vectors(path: Path, rows: int, dimension: int = 768) -> NDArray[np.float32]:
    """Reload the exact little-endian row-major contract, rejecting partial caches."""
    if rows < 1 or path.stat().st_size != rows * dimension * 4:
        raise ValueError("Text vector byte count does not match its row mapping and dimension")
    vectors = np.fromfile(path, dtype="<f4").reshape(rows, dimension)
    if not np.isfinite(vectors).all() or not np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-5, rtol=0):
        raise ValueError("Text vectors must be finite unit vectors")
    return vectors


def load_checkpoint(revision: str) -> tuple[Any, Any, Any]:
    if revision != MODEL_REVISION:
        raise ValueError("This adapter is verified for the documented immutable BioCLIP 2 revision only")
    directory = Path(".cache/checkpoint") / revision
    required = {"open_clip_config.json": CONFIG_SHA256, "open_clip_model.safetensors": CHECKPOINT_SHA256}
    if not all((directory / filename).is_file() for filename in required):
        snapshot_download(MODEL_REPO, revision=revision, local_dir=directory, allow_patterns=list(required))
    for filename, digest in required.items():
        if describe_file(directory / filename)["sha256"] != digest:
            raise ValueError(f"Checkpoint integrity failed: {filename}; remove the invalid cached file and retry")
    torch.set_num_threads(4)
    model, _, transform = open_clip.create_model_and_transforms(f"local-dir:{directory}", device="cpu")
    model.eval().requires_grad_(False)
    tokenizer = open_clip.get_tokenizer(f"local-dir:{directory}")
    return model, transform, tokenizer


def validate_prefix_text_model(model: Any) -> None:
    """Require the pinned causal/argmax FP32 contract before removing padding."""
    mask = getattr(model, "attn_mask", None)
    if (getattr(model, "context_length", None) != 77 or getattr(model, "text_pool_type", None) != "argmax" or
            getattr(model, "cls_emb", None) is not None or getattr(model, "use_pad_mask", False) or
            getattr(model, "training", True) or not isinstance(mask, torch.Tensor) or mask.shape != (77, 77)):
        raise ValueError("Causal-prefix preparation requires the pinned eval-mode causal EOT model without CLS/pad pooling")
    if not torch.equal(mask, torch.full_like(mask, -torch.inf).triu_(1)):
        raise ValueError("Causal-prefix preparation requires a strictly causal attention mask")
    if (mask.dtype != torch.float32 or model.transformer.get_cast_dtype() != torch.float32 or model.token_embedding.weight.dtype != torch.float32 or
            model.positional_embedding.dtype != torch.float32 or model.positional_embedding.shape[0] != 77 or
            any(parameter.dtype != torch.float32 for parameter in model.parameters())):
        raise ValueError("Causal-prefix preparation requires unchanged FP32 model parameters")
    if not isinstance(getattr(model, "text_projection", None), (torch.Tensor, torch.nn.Linear)):
        raise ValueError("Causal-prefix preparation requires the pinned text projection")


def encode_text_causal_prefix(model: Any, tokens: torch.Tensor, device: str) -> torch.Tensor:
    """Drop only CPU-tokenizer padding after every prompt's retained EOT token."""
    if tokens.device.type != "cpu" or tokens.ndim != 2 or tokens.shape[0] < 1 or tokens.shape[1] != 77 or tokens.dtype != torch.int64:
        raise ValueError("Causal-prefix encoding needs a nonempty CPU int64 token batch with context 77")
    eos = tokens.argmax(dim=-1)
    if (not torch.all(tokens[:, 0] == 49406) or not torch.all(tokens[torch.arange(len(tokens)), eos] == 49407) or
            not torch.all((tokens == 49407).sum(dim=-1) == 1) or torch.any(tokens < 0)):
        raise ValueError("Causal-prefix token batches must retain exactly one highest-ID EOT per prompt")
    if torch.any(tokens[torch.arange(77).unsqueeze(0) > eos.unsqueeze(1)] != 0):
        raise ValueError("Causal-prefix encoding cannot remove non-padding tokens after EOT")
    length = int(eos.max().item()) + 1
    text = tokens[:, :length].to(device)
    dtype = model.transformer.get_cast_dtype()
    x = model.token_embedding(text).to(dtype)
    x = x + model.positional_embedding[:length].to(dtype)
    x = model.transformer(x, attn_mask=model.attn_mask[:length, :length])
    x = model.ln_final(x)
    x = text_global_pool(x, text, model.text_pool_type, eos_token_id=getattr(model, "text_eos_id", None))
    if isinstance(model.text_projection, torch.nn.Linear):
        result: torch.Tensor = model.text_projection(x)
    else:
        result = x @ model.text_projection
    return result


def prompt_vectors(model: Any, tokenizer: Any, names: list[str], templates: list[str], device: str) -> NDArray[np.float32]:
    """Match the pinned CustomLabelsClassifier, transposed to one row per label."""
    if not names or not templates or any(not name.strip() for name in names):
        raise ValueError("Prompt vectors need non-empty labels and templates")
    validate_prefix_text_model(model)
    output = np.empty((len(names), 768), dtype="<f4")
    model.to(device)
    try:
        with torch.inference_mode():
            for i, name in enumerate(names):
                tokens = tokenizer([t.format(name=name.strip()) for t in templates])
                prompts = encode_text_causal_prefix(model, tokens, device).float()
                if prompts.shape != (len(templates), 768) or not torch.isfinite(prompts).all() or torch.any(prompts.norm(dim=-1) == 0):
                    raise ValueError("Text encoder output must contain one finite nonzero 768-vector per prompt")
                prompts = torch.nn.functional.normalize(prompts, dim=-1)
                vector = torch.nn.functional.normalize(prompts.mean(dim=0), dim=0)
                output[i] = vector.cpu().numpy()
                if i % 100 == 0 or i + 1 == len(names):
                    print(f"Text vectors: {i + 1}/{len(names)}", flush=True)
    finally:
        model.cpu()
    if not np.isfinite(output).all() or not np.allclose(np.linalg.norm(output, axis=1), 1, atol=1e-5, rtol=0):
        raise ValueError("Text vectors must be finite unit vectors")
    return output


def validate_onnx(path: Path) -> None:
    """Reject truncated graphs, wrong I/O contracts, and unlisted external data."""
    onnx.checker.check_model(str(path))
    graph = onnx.load(path, load_external_data=False)
    if any(weight.data_location == onnx.TensorProto.EXTERNAL for weight in graph.graph.initializer):
        raise ValueError("This exporter requires a self-contained ONNX encoder")
    for values, name, shape in [(graph.graph.input, "images", [1, 3, 224, 224]),
                                (graph.graph.output, "embedding", [1, 768])]:
        if len(values) != 1 or values[0].name != name:
            raise ValueError(f"Unexpected ONNX {name} contract")
        tensor = values[0].type.tensor_type
        if tensor.elem_type != onnx.TensorProto.FLOAT or [dim.dim_value for dim in tensor.shape.dim] != shape:
            raise ValueError(f"Unexpected ONNX {name} type or shape")


def cached_artifact(path: Path, recipe: dict[str, Any]) -> bool:
    """Reuse only a fully published artifact with the exact recipe and file hash."""
    receipt = path.with_suffix(".json")
    if not path.exists() or not receipt.exists():
        return False
    try:
        expected = json.loads(receipt.read_text(encoding="utf-8"))
        if not isinstance(expected, dict):
            return False
        return bool(expected["recipe"] == recipe and expected["file"] == describe_file(path))
    except (ValueError, KeyError, OSError):
        return False


def prepare_model(catalog_path: Path, revision: str, output: Path, limit: int | None = None) -> Path:
    started = time.perf_counter()
    if revision != MODEL_REVISION:
        raise ValueError("Only the pinned immutable BioCLIP 2 revision is supported")
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    index_path = catalog_path.parent / catalog["indexFile"]
    index_asset = next(file for file in catalog["files"] if file["url"] == catalog["indexFile"])
    if describe_file(index_path) != index_asset:
        raise ValueError("Catalog index integrity failed")
    rows = json.loads(index_path.read_text(encoding="utf-8"))
    if len(rows) != catalog["taxonCount"] or len({r["id"] for r in rows}) != len(rows):
        raise ValueError("Catalog count or row identities are invalid")
    if limit is not None:
        if limit < 5 or limit > len(rows):
            raise ValueError("A feasibility subset needs between five labels and the full catalog count")
        rows = rows[:limit]
    if len(rows) < 5 or any(not isinstance(r["scientificName"], str) or not r["scientificName"].strip() for r in rows):
        raise ValueError("The model requires at least five non-empty catalog labels")
    prompt_document = json.loads(Path(__file__).with_name("prompts.json").read_text(encoding="utf-8"))
    templates = prompt_document["templates"]
    prompt_hash = hashlib.sha256(json.dumps(templates, separators=(",", ":")).encode("utf-8")).hexdigest()
    if prompt_hash != PROMPT_SHA256:
        raise ValueError("Prompt templates differ from the verified pinned official ensemble")
    runtime = json.loads(Path("public/runtime/manifest.json").read_text(encoding="utf-8"))
    runtime_files = []
    for file in runtime["files"]:
        if describe_file(Path("public/runtime") / file["url"], file["url"]) != file:
            raise ValueError("Self-hosted runtime integrity failed")
        runtime_files.append({**file, "url": "../../../runtime/" + file["url"]})
    versions = {name: importlib.metadata.version(name) for name in
                ["torch", "torchvision", "open-clip-torch", "onnx", "onnxruntime", "pillow", "numpy", "safetensors"]}
    image_recipe = {"version": EXPORT_VERSION, "revision": revision, "checkpointSha256": CHECKPOINT_SHA256,
                    "configSha256": CONFIG_SHA256, "versions": versions, "opset": 17,
                    "attentionExport": "torch.backends.mha fastpath disabled only during legacy export"}
    export_id = hashlib.sha256(json.dumps(image_recipe, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:20]
    fp16_recipe = {"version": STORAGE_RECIPE, "fp32Recipe": image_recipe,
                   "minimumRank": MINIMUM_RANK, "minimumElements": MINIMUM_ELEMENTS,
                   "preservedWeightsPolicy": PRESERVED_WEIGHTS_POLICY,
                   "storageType": "float16", "arithmeticType": "float32", "inputOutputType": "float32"}
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    vector_recipe = {"version": VECTOR_VERSION, "imageRecipe": image_recipe, "device": device,
                     "labels": [[r["id"], r["scientificName"].strip()] for r in rows], "promptSha256": prompt_hash,
                     "textContext": TEXT_CONTEXT_POLICY}
    vector_id = hashlib.sha256(json.dumps(vector_recipe, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    identity = {"version": 2, "exportId": export_id, "vectorId": vector_id, "catalogId": catalog["id"],
                "catalogSha256": catalog["sourceSha256"], "preprocessingSha256": PREPROCESS_SHA256,
                "runtime": runtime, "fp16Recipe": fp16_recipe}
    pack_id = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:20]
    directory = output / pack_id
    if (directory / "manifest.json").exists():
        previous = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        if previous.get("preparationIdentity") != identity:
            raise ValueError("An existing immutable pack has a conflicting identity")
        for file in previous["files"]:
            if describe_file(directory / file["url"], file["url"]) != file:
                raise ValueError("An existing immutable pack is corrupt; remove that pack and prepare it again")
        write_json_asset(output.parent.parent, "model.json", {"url": f"packs/bioclip2/{pack_id}/manifest.json"})
        return directory / "manifest.json"

    output.mkdir(parents=True, exist_ok=True)
    export_directory = Path(".cache/exports") / export_id
    export_directory.mkdir(parents=True, exist_ok=True)
    fp32_path = export_directory / "image.fp32.onnx"
    fp16_path = export_directory / "image.fp16.onnx"
    vector_directory = Path(".cache/vectors")
    vector_directory.mkdir(parents=True, exist_ok=True)
    vector_path = vector_directory / f"{vector_id}.f32"
    needs_vectors = not cached_artifact(vector_path, vector_recipe)
    needs_encoder = not cached_artifact(fp32_path, image_recipe)
    model, transform, tokenizer = load_checkpoint(revision) if needs_vectors or needs_encoder else (None, None, None)
    if not needs_vectors:
        validate_vectors(vector_path, len(rows))
    else:
        vectors = prompt_vectors(model, tokenizer, [r["scientificName"] for r in rows], templates, device)
        temporary_vector = vector_path.with_suffix(".tmp")
        try:
            vectors.tofile(temporary_vector)
            validate_vectors(temporary_vector, len(rows))
            os.replace(temporary_vector, vector_path)
            write_json_asset(vector_directory, vector_path.with_suffix(".json").name,
                             {"recipe": vector_recipe, "file": describe_file(vector_path)})
        finally:
            temporary_vector.unlink(missing_ok=True)

    encoder: ImageEncoder | None = None
    if needs_encoder:
        assert model is not None
        encoder = ImageEncoder(model.visual).eval()
    del model, tokenizer, transform
    gc.collect()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
    if needs_encoder:
        assert encoder is not None
        print("Exporting complete FP32 image encoder", flush=True)
        temporary_export = fp32_path.with_name("image.fp32.tmp.onnx")
        try:
            with exportable_attention():
                torch.onnx.export(encoder, (torch.zeros(1, 3, 224, 224),), str(temporary_export),
                                  input_names=["images"], output_names=["embedding"], opset_version=17,
                                  dynamo=False, external_data=False)
            validate_onnx(temporary_export)
            os.replace(temporary_export, fp32_path)
            write_json_asset(export_directory, "image.fp32.json", {"recipe": image_recipe, "file": describe_file(fp32_path)})
        finally:
            temporary_export.unlink(missing_ok=True)
    del encoder
    gc.collect()
    if not cached_artifact(fp16_path, fp16_recipe):
        print("Storing large encoder matrices in FP16; preserving FP32 arithmetic", flush=True)
        temporary_export = fp16_path.with_name("image.fp16.tmp.onnx")
        try:
            graph = onnx.load(fp32_path)
            conversion = quantize_weight_storage(graph, minimum_elements=MINIMUM_ELEMENTS)
            onnx.save(graph, temporary_export)
            del graph
            gc.collect()
            validate_onnx(temporary_export)
            os.replace(temporary_export, fp16_path)
            write_json_asset(export_directory, "image.fp16.json", {"recipe": fp16_recipe, "file": describe_file(fp16_path),
                                                                  "conversion": conversion})
        finally:
            temporary_export.unlink(missing_ok=True)
    encoder_hash = describe_file(fp16_path)["sha256"]
    weights = output / "weights"
    weights.mkdir(exist_ok=True)
    shared_weights = weights / f"{encoder_hash}.onnx"
    if not shared_weights.exists():
        try:
            os.link(fp16_path, shared_weights)
        except OSError:
            temporary_weights = shared_weights.with_suffix(".tmp")
            try:
                shutil.copyfile(fp16_path, temporary_weights)
                os.replace(temporary_weights, shared_weights)
            finally:
                temporary_weights.unlink(missing_ok=True)
    model_asset = describe_file(shared_weights, f"../weights/{shared_weights.name}")
    if model_asset["sha256"] != encoder_hash:
        raise ValueError("Shared encoder content hash does not match its immutable filename")
    staging = Path(tempfile.mkdtemp(prefix=f".{pack_id}.", dir=output))
    try:
        shutil.copyfile(vector_path, staging / "vectors.f32")
        vector_asset = describe_file(staging / "vectors.f32")
        mapping_asset = write_json_asset(staging, "rows.json", [r["id"] for r in rows])
        manifest = {
            "schemaVersion": 1, "kind": "bioclip2", "id": pack_id,
            "name": "BioCLIP 2" + (f" · feasibility subset ({len(rows)})" if limit else " · PFAF"),
            "model": {"repository": MODEL_REPO, "revision": revision, "checkpointSha256": CHECKPOINT_SHA256,
                      "configSha256": CONFIG_SHA256, "precision": "FP16 matrix storage with FP32 arithmetic and input/output", "opset": 17, "dimension": 768,
                      "inputName": "images", "inputShape": [1, 3, 224, 224],
                      "outputName": "embedding", "outputShape": [1, 768], "externalData": [], "file": model_asset},
            "catalog": {"id": catalog["id"], "sourceSha256": catalog["sourceSha256"],
                        "url": f"../../pfaf/{catalog['id']}/manifest.json", "taxonCount": len(rows),
                        "fullTaxonCount": catalog["taxonCount"], "rows": mapping_asset},
            "vectors": {"file": vector_asset, "shape": [len(rows), 768], "dtype": "float32", "byteOrder": "little"},
            "preprocessing": {**PREPROCESS, "sha256": PREPROCESS_SHA256, "hashSerialization": PREPROCESS_SERIALIZATION},
            "prompts": {"templates": templates, "sha256": prompt_hash, "source": prompt_document["source"],
                        "sourceSha256": prompt_document["sourceSha256"], "tokenizer": f"{MODEL_REPO}@{revision}",
                        "normalization": "normalize prompts; mean; normalize mean"},
            "scoring": {"version": 1, "policy": "single-photo cosine", "rejection": "disabled; candidate-only"},
            "runtime": {"version": runtime["version"], "files": runtime_files},
            "reference": {"fp32Export": str(fp32_path), "file": describe_file(fp32_path)},
            "exporterVersions": versions, "preparationIdentity": identity,
            "vectorPreparation": {"device": device, "recipe": VECTOR_VERSION, "textContext": TEXT_CONTEXT_POLICY},
            "files": [model_asset, vector_asset, mapping_asset, *runtime_files],
        }
        write_json_asset(staging, "manifest.json", manifest)
        os.replace(staging, directory)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    output.parent.parent.mkdir(parents=True, exist_ok=True)
    write_json_asset(output.parent.parent, "model.json", {"url": f"packs/bioclip2/{pack_id}/manifest.json"})
    print(f"Prepared {len(rows)} labels in {time.perf_counter() - started:.1f}s; encoder {model_asset['bytes']} bytes", flush=True)
    return directory / "manifest.json"
