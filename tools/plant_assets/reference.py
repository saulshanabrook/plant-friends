"""Numerical reference inputs for Python, ONNX CPU, and real browser checks."""

from __future__ import annotations

import gc
import json
import os
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
import torch
from numpy.typing import NDArray
from PIL import Image, ImageOps, features

from .catalog import write_json_asset
from .model import PREPROCESS_SHA256, describe_file, load_checkpoint, validate_vectors

FP32_ONNX_TOLERANCES = {"minimumCosine": 0.9999, "maximumNormalizedEmbeddingError": 0.001}


def canonical_image(path: Path) -> Image.Image:
    """Orient exactly once, discard metadata, and composite alpha on opaque white.

    Channel values are interpreted as sRGB. Embedded ICC profiles are not applied;
    this matches browser decoding with colorSpaceConversion='none'.
    """
    with Image.open(path) as original:
        oriented = ImageOps.exif_transpose(original)
        if oriented.mode in ("RGBA", "LA") or "transparency" in oriented.info:
            rgba = oriented.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            result = Image.alpha_composite(background, rgba).convert("RGB")
        else:
            result = oriented.convert("RGB")
        result.info.clear()
        return result


def compare_embeddings(expected: NDArray[np.float32], actual: NDArray[np.float32]) -> dict[str, float]:
    """Compare direction in FP64 and fail explicitly on zero/invalid encoders."""
    if expected.shape != (768,) or actual.shape != (768,) or not np.isfinite(expected).all() or not np.isfinite(actual).all():
        raise ValueError("Reference embeddings must be finite 768-vectors")
    left = expected.astype(np.float64)
    right = actual.astype(np.float64)
    if np.linalg.norm(left) == 0 or np.linalg.norm(right) == 0:
        raise ValueError("Reference embeddings must have nonzero norms")
    left /= np.linalg.norm(left)
    right /= np.linalg.norm(right)
    return {"cosine": float(np.clip(np.dot(left, right), -1, 1)),
            "maxNormalizedEmbeddingError": float(np.max(np.abs(left - right)))}


def licensed_photo_sample(photo: dict[str, Any], directory: Path) -> dict[str, Any]:
    """Bind a numerical sample to the exact licensed photo bytes in the manifest."""
    source = directory.parent / "photos" / photo["file"]
    if describe_file(source)["sha256"] != photo["sha256"]:
        raise ValueError(f"Fixture integrity failed: {source}")
    return {"id": str(photo["photoId"]), "photoUrl": "../photos/" + photo["file"]}


def create_references(pack_path: Path, check_export: bool) -> Path:
    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    if pack["preprocessing"]["sha256"] != PREPROCESS_SHA256:
        raise ValueError("Reference preprocessing differs from the prepared pack")
    photos = json.loads(Path("fixtures/photos.json").read_text(encoding="utf-8"))["photos"]
    directory = Path("public/fixtures/reference")
    directory.mkdir(parents=True, exist_ok=True)
    samples: list[dict[str, Any]] = []
    for photo in photos[::2][:3]:
        samples.append(licensed_photo_sample(photo, directory))
    for name, width, height in [("portrait", 317, 509), ("landscape", 640, 480), ("small", 7, 11)]:
        y, x, c = np.indices((height, width, 3))
        rgb = ((x * 13 + y * 7 + c * 59 + x * y % 113) % 256).astype(np.uint8)
        Image.fromarray(rgb).save(directory / f"{name}.png")
        samples.append({"id": name, "photoUrl": f"{name}.png"})
    rgba = Image.new("RGBA", (319, 251), (31, 149, 79, 127))
    rgba.save(directory / "transparent.png")
    samples.append({"id": "transparent", "photoUrl": "transparent.png"})
    with Image.open(directory / "portrait.png") as orientation:
        exif = orientation.getexif()
        exif[274] = 6
        orientation.save(directory / "oriented.jpg", exif=exif)
    samples.append({"id": "oriented", "photoUrl": "oriented.jpg"})
    with Image.open(directory / "landscape.png") as landscape:
        landscape.save(directory / "landscape.webp", format="WEBP", lossless=True, exact=True, method=6)
    samples.append({"id": "webp", "photoUrl": "landscape.webp", "derivedFrom": "landscape.png",
                    "encoding": {"format": "WebP", "lossless": True, "exact": True, "method": 6,
                                 "libwebpVersion": features.version("webp")}})
    samples.append({**licensed_photo_sample(photos[6], directory), "purpose": "prospective extra regression sample"})

    for file in [pack["catalog"]["rows"], pack["vectors"]["file"]]:
        if describe_file(pack_path.parent / file["url"], file["url"]) != file:
            raise ValueError("Pack vector or row mapping integrity failed")
    rows = json.loads((pack_path.parent / pack["catalog"]["rows"]["url"]).read_text(encoding="utf-8"))
    vectors = validate_vectors(pack_path.parent / pack["vectors"]["file"]["url"], len(rows))
    if len(rows) != pack["catalog"]["taxonCount"] or len(set(rows)) != len(rows):
        raise ValueError("Reference pack row mapping is inconsistent")
    model, transform, _ = load_checkpoint(pack["model"]["revision"])
    report: dict[str, Any] = {
        "schemaVersion": 1, "packId": pack["id"], "modelRevision": pack["model"]["revision"],
        "checkpointSha256": pack["model"]["checkpointSha256"], "preprocessingSha256": PREPROCESS_SHA256,
        "promptSha256": pack["prompts"]["sha256"], "catalogId": pack["catalog"]["id"],
        "inputShape": [1, 3, 224, 224], "embeddingShape": [1, 768], "dtype": "float32", "byteOrder": "little",
        "fp32OnnxTolerances": FP32_ONNX_TOLERANCES, "exportChecked": check_export,
        "limitations": "FP32 ONNX tolerances are separate from browser FP16 and complete image-pipeline tolerances",
        "samples": [],
    }
    with torch.inference_mode():
        for sample in samples:
            tensor = transform(canonical_image(directory / sample["photoUrl"])).unsqueeze(0)
            if tensor.shape != (1, 3, 224, 224) or not torch.isfinite(tensor).all():
                raise ValueError("OpenCLIP preprocessing returned an invalid input tensor")
            embedding = model.encode_image(tensor).float().cpu().numpy().astype("<f4").reshape(-1)
            compare_embeddings(embedding, embedding)
            for suffix, array in [("input", tensor.cpu().numpy().astype("<f4")), ("embedding", embedding)]:
                filename = f"{sample['id']}.{suffix}.f32"
                target = directory / filename
                temporary = target.with_suffix(".tmp")
                try:
                    array.tofile(temporary)
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
                sample[f"{suffix}Url"] = filename
                sample[f"{suffix}File"] = describe_file(target)
            scores = vectors @ (embedding / np.linalg.norm(embedding))
            order = sorted(range(len(rows)), key=lambda i: (-float(scores[i]), rows[i]))[:5]
            sample["pythonTopFive"] = [{"taxonId": rows[i], "similarity": float(scores[i])} for i in order]
            sample["photoFile"] = describe_file(directory / sample["photoUrl"], sample["photoUrl"])
            report["samples"].append(sample)
    del model, transform
    gc.collect()
    if check_export:
        fp32_path = Path(pack["reference"]["fp32Export"])
        if describe_file(fp32_path) != pack["reference"]["file"]:
            raise ValueError("The local FP32 reference export changed after preparation")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        session = ort.InferenceSession(str(fp32_path), sess_options=options, providers=["CPUExecutionProvider"])
        for sample in report["samples"]:
            tensor_array = np.fromfile(directory / sample["inputUrl"], dtype="<f4").reshape(1, 3, 224, 224)
            expected = np.fromfile(directory / sample["embeddingUrl"], dtype="<f4")
            actual = session.run([pack["model"]["outputName"]], {pack["model"]["inputName"]: tensor_array})[0].reshape(-1)
            metrics = compare_embeddings(expected, actual)
            sample["fp32OnnxCosine"] = metrics["cosine"]
            sample["fp32OnnxMaxEmbeddingError"] = metrics["maxNormalizedEmbeddingError"]
            if metrics["cosine"] < FP32_ONNX_TOLERANCES["minimumCosine"] or metrics["maxNormalizedEmbeddingError"] > FP32_ONNX_TOLERANCES["maximumNormalizedEmbeddingError"]:
                raise ValueError(f"FP32 export parity failed: {sample['id']} {metrics}")
            print(f"FP32 ONNX {sample['id']}: {metrics}", flush=True)
    write_json_asset(directory, "manifest.json", report)
    Path("reports").mkdir(exist_ok=True)
    write_json_asset(Path("reports"), "python-reference.json", report)
    return directory / "manifest.json"
