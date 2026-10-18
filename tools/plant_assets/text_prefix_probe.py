"""Causal-prefix parity/timing probe for the pinned BioCLIP text tower.

This diagnostic never changes preparation, checkpoint files, or public assets.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import inspect
import json
import statistics
import time
from pathlib import Path
from typing import Any

import numpy as np
import open_clip
import torch
from open_clip.model import CLIP, _build_text_tower
from open_clip.transformer import text_global_pool
from safetensors import safe_open

CHECKPOINT_SHA256 = "b7b2bf6fbc95799e42630e394cf95803892ab447c1a8ab629dbc82fbeaf7dfef"
CONFIG_SHA256 = "1bf947e96e943fe50efd5c3e26c37f843a2fa3c358967719a68c8a6d17ce68c8"
STRICT_MINIMUM_COSINE = 1 - 1e-9
STRICT_MAXIMUM_COORDINATE_ERROR = 1e-6
LABELS = ["Abelia triflora", "Salvia officinalis", "Achillea millefolium", "Abutilon x hybridum",
          "Fragaria vesca 'Semperflorens'", "Brassica juncea integrifolia subintegrifolia",
          "Cylindropuntia imbricata subsp. spinosior"]


def prefix_encode_text(model: Any, tokens: torch.Tensor, length: int) -> torch.Tensor:
    """Use the official CLIP operations with positional and causal-mask prefixes."""
    text = tokens[:, :length]
    dtype = model.transformer.get_cast_dtype()
    x = model.token_embedding(text).to(dtype)
    x = x + model.positional_embedding[:length].to(dtype)
    x = model.transformer(x, attn_mask=model.attn_mask[:length, :length])
    x = model.ln_final(x)
    x = text_global_pool(x, text, model.text_pool_type, eos_token_id=model.text_eos_id)
    if isinstance(model.text_projection, torch.nn.Linear):
        result: torch.Tensor = model.text_projection(x)
    else:
        result = x @ model.text_projection
    return result


def embedding_metrics(expected: torch.Tensor, actual: torch.Tensor) -> dict[str, float]:
    """Compare all row directions in FP64, without changing encoder precision."""
    left = expected.cpu().numpy().astype(np.float64)
    right = actual.cpu().numpy().astype(np.float64)
    if left.shape != right.shape or not np.isfinite(left).all() or not np.isfinite(right).all():
        raise ValueError("Nonfinite or mismatched text outputs")
    left /= np.linalg.norm(left, axis=-1, keepdims=True)
    right /= np.linalg.norm(right, axis=-1, keepdims=True)
    return {"minimumCosine": float(np.clip(np.sum(left * right, axis=-1), -1, 1).min()),
            "maximumNormalizedCoordinateError": float(np.abs(left - right).max()),
            "maximumRawCoordinateError": float(torch.max(torch.abs(expected - actual)).item())}


def run_probe(checkpoint: Path, prompts_path: Path, output: Path, repeats: int, device: str = "cpu", check_production: bool = False) -> None:
    if repeats < 1:
        raise ValueError("At least one alternating timing repeat is required")
    config_path = checkpoint.parent / "open_clip_config.json"
    for path, expected in [(checkpoint, CHECKPOINT_SHA256), (config_path, CONFIG_SHA256)]:
        with path.open("rb") as file:
            actual = hashlib.file_digest(file, "sha256").hexdigest()
        if actual != expected:
            raise ValueError(f"Pinned source integrity failed: {path}")
    config = json.loads(config_path.read_text())["model_cfg"]
    text_config = config["text_cfg"]
    if text_config.get("no_causal_mask", False) or text_config.get("embed_cls", False) or text_config.get("pool_type", "argmax") != "argmax":
        raise ValueError("NO-GO: text configuration is not causal EOS/argmax pooling without CLS")
    torch.set_num_threads(4)
    # Build exactly the text tower that CLIP.__init__ flattens onto itself. Load
    # only its named state, avoiding allocation of the unrelated visual encoder.
    model = _build_text_tower(config["embed_dim"], text_config, quick_gelu=config.get("quick_gelu", False), cast_dtype=None)
    with safe_open(checkpoint, framework="pt", device="cpu") as tensors:
        state = {name: tensors.get_tensor(name) for name in model.state_dict()}
    model.load_state_dict(state, strict=True)
    del state
    model.eval().requires_grad_(False)
    model.text_pool_type = model.pool_type
    model.text_eos_id = model.eos_id
    expected_mask = torch.full((77, 77), -torch.inf).triu_(1)
    if (model.cls_emb is not None or model.use_pad_mask or model.pool_type != "argmax" or
            model.attn_mask is None or not torch.equal(model.attn_mask, expected_mask) or
            model.transformer.get_cast_dtype() != torch.float32 or
            any(parameter.device.type != "cpu" or parameter.dtype != torch.float32 for parameter in model.parameters())):
        raise ValueError("NO-GO: actual locked model does not satisfy CPU FP32 causal-prefix assumptions")
    if device == "mps" and not torch.backends.mps.is_available():
        raise ValueError("NO-GO: MPS is unavailable")
    if check_production:
        from tools.plant_assets.model import encode_text_causal_prefix, validate_prefix_text_model
        validate_prefix_text_model(model)
    model.to(device)
    tokenizer = open_clip.get_tokenizer(f"local-dir:{checkpoint.parent}")
    templates = json.loads(prompts_path.read_text())["templates"]
    if len(templates) != 80:
        raise ValueError("The complete 80-template ensemble is required")
    report: dict[str, Any] = {
        "kind": "causal-prefix-probe", "status": "pending", "device": device, "threads": 4,
        "checkpointSha256": CHECKPOINT_SHA256, "configSha256": CONFIG_SHA256, "textConfig": text_config,
        "promptSha256": hashlib.sha256(json.dumps(templates, separators=(",", ":")).encode()).hexdigest(),
        "officialEncodeTextSourceSha256": hashlib.sha256(inspect.getsource(CLIP.encode_text).encode()).hexdigest(),
        "versions": {name: importlib.metadata.version(name) for name in ("torch", "open-clip-torch", "numpy", "safetensors")},
        "assumptions": {"causalMask": "zero on/below diagonal and -inf above", "pooling": "highest-token-ID EOS",
                        "clsEmbedding": False, "padMask": False, "contextLength": 77, "precision": "FP32",
                        "tokenizer": type(tokenizer).__name__, "allOperationsDevice": device},
        "diagnosticLimits": {"minimumCosine": STRICT_MINIMUM_COSINE, "maximumNormalizedCoordinateError": STRICT_MAXIMUM_COORDINATE_ERROR},
        "limitsChanged": False, "productionChanged": False, "samples": [],
        "timingPolicy": {"warmEveryLength": True, "synchronize": device == "mps", "transfersAndTokenizationIncluded": False},
        "limitations": "Encoding timings exclude tokenization, transfer, ensemble reduction, and startup. Full production preparation remains untouched.",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with torch.inference_mode():
        for index, label in enumerate(LABELS):
            tokens = tokenizer([template.format(name=label.strip()) for template in templates])
            eos = tokens.argmax(dim=-1)
            if tokens.shape != (80, 77) or not torch.all(tokens[torch.arange(80), eos] == 49407) or not torch.all((tokens == 49407).sum(dim=-1) == 1):
                raise ValueError("NO-GO: token/EOS contract differs from pinned CLIP")
            trailing = torch.arange(77).unsqueeze(0) > eos.unsqueeze(1)
            if torch.any(tokens[trailing] != 0):
                raise ValueError("NO-GO: proposed truncation removes non-padding content")
            length = int(eos.max().item()) + 1
            cpu_tokens = tokens
            tokens = tokens.to(device)
            if index == 0:
                # This also validates the flattened tower wrapper against the
                # official method before testing any shortened context.
                warm_full = CLIP.encode_text(model, tokens)
                warm_control = prefix_encode_text(model, tokens, 77)
                report["fullLengthControlBitwiseEqual"] = bool(torch.equal(warm_full, warm_control))
                if not report["fullLengthControlBitwiseEqual"]:
                    raise ValueError("NO-GO: full-length adapter differs from official encode_text")
            CLIP.encode_text(model, tokens)
            prefix_encode_text(model, tokens, length)
            if device == "mps":
                torch.mps.synchronize()
            full_times = []
            prefix_times = []
            full = torch.empty(0)
            prefix = torch.empty(0)
            for repeat in range(repeats):
                for trial_path in (["full", "prefix"] if repeat % 2 == 0 else ["prefix", "full"]):
                    if device == "mps":
                        torch.mps.synchronize()
                    started = time.perf_counter()
                    if trial_path == "full":
                        full = CLIP.encode_text(model, tokens)
                        if device == "mps":
                            torch.mps.synchronize()
                        full_times.append((time.perf_counter() - started) * 1000)
                    else:
                        prefix = prefix_encode_text(model, tokens, length)
                        if device == "mps":
                            torch.mps.synchronize()
                        prefix_times.append((time.perf_counter() - started) * 1000)
            prompts = embedding_metrics(full, prefix)
            full_ensemble = torch.nn.functional.normalize(torch.nn.functional.normalize(full, dim=-1).mean(dim=0), dim=0)
            prefix_ensemble = torch.nn.functional.normalize(torch.nn.functional.normalize(prefix, dim=-1).mean(dim=0), dim=0)
            ensemble = embedding_metrics(full_ensemble.unsqueeze(0), prefix_ensemble.unsqueeze(0))
            passed = all(metrics["minimumCosine"] >= STRICT_MINIMUM_COSINE and
                         metrics["maximumNormalizedCoordinateError"] <= STRICT_MAXIMUM_COORDINATE_ERROR for metrics in (prompts, ensemble))
            sample = {"label": label, "prefixLength": length, "eosRange": [int(eos.min()), int(eos.max())],
                      "promptMetrics": prompts, "ensembleMetrics": ensemble, "passed": passed,
                      "fullTimesMs": full_times, "prefixTimesMs": prefix_times,
                      "medianFullMs": statistics.median(full_times), "medianPrefixMs": statistics.median(prefix_times),
                      "observedSpeedup": statistics.median(full_times) / statistics.median(prefix_times)}
            if check_production:
                encode_text_causal_prefix(model, cpu_tokens, device)
                if device == "mps":
                    torch.mps.synchronize()
                started = time.perf_counter()
                candidate = encode_text_causal_prefix(model, tokenizer([template.format(name=label.strip()) for template in templates]), device)
                candidate_ensemble = torch.nn.functional.normalize(torch.nn.functional.normalize(candidate, dim=-1).mean(dim=0), dim=0)
                candidate_ensemble.cpu().numpy()
                if device == "mps":
                    torch.mps.synchronize()
                sample["productionLikeMs"] = (time.perf_counter() - started) * 1000
                sample["productionAdapterBitwiseEqual"] = bool(torch.equal(full, candidate))
                production_metrics = embedding_metrics(full, candidate)
                sample["productionAdapterMetrics"] = production_metrics
                production_ensemble_metrics = embedding_metrics(full_ensemble.unsqueeze(0), candidate_ensemble.unsqueeze(0))
                sample["productionEnsembleMetrics"] = production_ensemble_metrics
                passed = passed and all(metrics["minimumCosine"] >= STRICT_MINIMUM_COSINE and
                                        metrics["maximumNormalizedCoordinateError"] <= STRICT_MAXIMUM_COORDINATE_ERROR
                                        for metrics in (production_metrics, production_ensemble_metrics))
                sample["passed"] = passed
            report["samples"].append(sample)
            print(json.dumps(sample), flush=True)
            if not passed:
                report["status"] = f"NO-GO: strict {device} parity failed"
                break
        else:
            report["status"] = f"GO: causal invariant and strict sampled {device} parity passed"
    report["summary"] = {
        "labels": len(report["samples"]), "allPassed": all(sample["passed"] for sample in report["samples"]),
        "minimumPromptCosine": min(sample["promptMetrics"]["minimumCosine"] for sample in report["samples"]),
        "maximumPromptNormalizedCoordinateError": max(sample["promptMetrics"]["maximumNormalizedCoordinateError"] for sample in report["samples"]),
        "minimumEnsembleCosine": min(sample["ensembleMetrics"]["minimumCosine"] for sample in report["samples"]),
        "maximumEnsembleNormalizedCoordinateError": max(sample["ensembleMetrics"]["maximumNormalizedCoordinateError"] for sample in report["samples"]),
    }
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Report: {output}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--prompts", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--repeats", default=2, type=int)
    parser.add_argument("--device", choices=("cpu", "mps"), default="cpu")
    parser.add_argument("--check-production", action="store_true")
    arguments = parser.parse_args()
    run_probe(arguments.checkpoint, arguments.prompts, arguments.output, arguments.repeats, arguments.device, arguments.check_production)


if __name__ == "__main__":
    main()
