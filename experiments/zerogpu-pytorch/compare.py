"""Compare same-revision PyTorch inference to Sentinel's existing ONNX pipeline."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_ID = "protectai/deberta-v3-base-prompt-injection-v2"
REVISION = "90c9989b1a342275dd0d1a95aad283c04e075671"
THRESHOLD = 0.5
MAX_TOKENS = 480
MAX_CHUNKS = 256
OVERLAP_CHARS = 64
BATCH_SIZE = 4
ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[1]
MODEL_DIR = ROOT / "model"


def _units(text: str) -> list[int]:
    raw = text.encode("utf-16-le", errors="surrogatepass")
    return [raw[i] | raw[i + 1] << 8 for i in range(0, len(raw), 2)]


def _from_units(units: list[int]) -> str:
    raw = bytearray()
    for unit in units:
        raw.extend((unit & 0xFF, unit >> 8))
    return bytes(raw).decode("utf-16-le", errors="surrogatepass")


def split_like_sentinel(
    text: str,
    tokenizer: Any,
    *,
    max_tokens: int = MAX_TOKENS,
    max_chunks: int = MAX_CHUNKS,
    overlap_chars: int = OVERLAP_CHARS,
    regions: list[dict[str, int]] | None = None,
) -> dict[str, Any]:
    """Mirror backend/classifier.js chunk boundaries and UTF-16 source offsets."""
    units = _units(text)
    valid_regions = [
        {"start": r["start"], "end": r["end"]}
        for r in (regions or [])
        if isinstance(r.get("start"), int)
        and isinstance(r.get("end"), int)
        and 0 <= r["start"] < r["end"] <= len(units)
    ] if regions is not None else []
    if regions is None:
        line_start = 0
        for index, unit in enumerate(units):
            if unit == 10:
                if index > line_start:
                    valid_regions.append({"start": line_start, "end": index})
                line_start = index + 1
        if len(units) > line_start:
            valid_regions.append({"start": line_start, "end": len(units)})
        if not valid_regions and units:
            valid_regions.append({"start": 0, "end": len(units)})

    chunks: list[dict[str, Any]] = []
    truncated = False
    for region in valid_regions:
        start, end = region["start"], region["end"]
        while start < end and len(chunks) < max_chunks:
            low, high, best = start + 1, min(end, start + 8192), start
            while low <= high:
                middle = (low + high) >> 1
                if start < middle < end and 0xD800 <= units[middle - 1] <= 0xDBFF:
                    middle -= 1
                candidate = _from_units(units[start:middle])
                count = len(tokenizer.encode(candidate, add_special_tokens=True))
                if count <= max_tokens:
                    best = middle
                    low = middle + 1
                else:
                    high = middle - 1
            if best <= start:
                best = min(end, start + 1)
            content = _from_units(units[start:best])
            chunks.append({
                "text": content,
                "start": start,
                "end": best,
                "token_count": len(tokenizer.encode(content, add_special_tokens=True)),
            })
            if best >= end:
                break
            next_start = max(start + 1, best - overlap_chars)
            if next_start < len(units) and 0xDC00 <= units[next_start] <= 0xDFFF:
                next_start += 1
            start = next_start
        if len(chunks) >= max_chunks and region["end"] < (valid_regions[-1]["end"] if valid_regions else 0):
            truncated = True
            break
    if chunks and len(chunks) >= max_chunks and chunks[-1]["end"] < len(units):
        truncated = True
    return {"chunks": chunks, "truncated": truncated}


def load_model(model_dir: Path = MODEL_DIR):
    torch.set_num_threads(2)
    config = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
    if config.get("architectures") != ["DebertaV2ForSequenceClassification"]:
        raise RuntimeError(f"Unexpected architecture: {config.get('architectures')}")
    if config.get("id2label") != {"0": "SAFE", "1": "INJECTION"}:
        raise RuntimeError(f"Unexpected labels: {config.get('id2label')}")
    if "Apache License" not in (model_dir / "LICENSE").read_text(encoding="utf-8"):
        raise RuntimeError("Model license was not verified")
    tokenizer = AutoTokenizer.from_pretrained(
        str(model_dir), local_files_only=True, use_fast=True, trust_remote_code=False
    )
    if not tokenizer.is_fast:
        raise RuntimeError("The experiment requires the pinned fast tokenizer")
    model = AutoModelForSequenceClassification.from_pretrained(
        str(model_dir), local_files_only=True, use_safetensors=True, trust_remote_code=False
    )
    model.eval()
    model.to(torch.device("cpu"))
    return tokenizer, model


def score_chunks(chunks: list[dict[str, Any]], tokenizer: Any, model: Any) -> list[float]:
    scores: list[float] = []
    injection_id = int(model.config.label2id["INJECTION"])
    for offset in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[offset : offset + BATCH_SIZE]
        encoded = tokenizer(
            [item["text"] for item in batch],
            padding=True,
            truncation=False,
            add_special_tokens=True,
            return_tensors="pt",
        )
        if encoded["input_ids"].shape[1] > MAX_TOKENS:
            raise RuntimeError("Python tokenizer disagrees with Sentinel token-window limit")
        with torch.inference_mode():
            logits = model(**encoded).logits
            probs = torch.softmax(logits, dim=-1)[:, injection_id]
        scores.extend(float(score) for score in probs.tolist())
    return scores


def metrics(samples: list[dict[str, Any]], prediction_key: str) -> dict[str, Any]:
    tp = fp = tn = fn = 0
    for sample in samples:
        expected = sample["label"] == "attack"
        detected = bool(sample[prediction_key])
        if expected and detected:
            tp += 1
        elif expected:
            fn += 1
        elif detected:
            fp += 1
        else:
            tn += 1
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return {
        "confusion": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
        "false_positive_rate": fp / (fp + tn) if fp + tn else 0.0,
    }


def run() -> dict[str, Any]:
    baseline_process = subprocess.run(
        ["node", "scripts/zerogpu-baseline.js"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    baseline = json.loads(baseline_process.stdout)
    corpus = json.loads((REPO_ROOT / "datasets/evaluation.json").read_text(encoding="utf-8"))
    if baseline["revision"] != REVISION or baseline["threshold"] != THRESHOLD:
        raise RuntimeError("Baseline model revision or threshold does not match the experiment")

    load_started = time.perf_counter()
    tokenizer, model = load_model()
    model_load_seconds = time.perf_counter() - load_started
    per_item_latency: dict[str, float] = {}
    pytorch_scores: dict[str, list[float]] = {}
    chunk_results: dict[str, list[dict[str, Any]]] = {}
    for sample in corpus["samples"]:
        cut = split_like_sentinel(sample["text"], tokenizer)
        started = time.perf_counter()
        scores = score_chunks(cut["chunks"], tokenizer, model)
        elapsed_ms = (time.perf_counter() - started) * 1000
        per_item_latency[sample["id"]] = elapsed_ms / max(len(scores), 1)
        pytorch_scores[sample["id"]] = scores
        chunk_results[sample["id"]] = cut["chunks"]

    adjudication_input = {
        "threshold": THRESHOLD,
        "samples": [
            {
                "id": sample["id"],
                "text": sample["text"],
                "structural_kind": sample.get("structural_kind"),
                "chunks": [
                    {**chunk, "injection_score": score,
                     "label": "INJECTION" if score >= THRESHOLD else "SAFE"}
                    for chunk, score in zip(chunk_results[sample["id"]], pytorch_scores[sample["id"]])
                ],
            }
            for sample in corpus["samples"]
        ],
    }
    adjudication_process = subprocess.run(
        ["node", "scripts/zerogpu-adjudicate.js"],
        cwd=REPO_ROOT,
        input=json.dumps(adjudication_input, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    adjudication = json.loads(adjudication_process.stdout)
    adjudicated_by_id = {sample["id"]: sample for sample in adjudication["samples"]}

    baseline_by_id = {sample["id"]: sample for sample in baseline["samples"]}
    samples = []
    for sample in corpus["samples"]:
        old = baseline_by_id[sample["id"]]
        chunks = chunk_results[sample["id"]]
        torch_scores = pytorch_scores[sample["id"]]
        old_scores = [item["injection_score"] for item in old["chunks"]]
        torch_max = max(torch_scores, default=0.0)
        baseline_max = max(old_scores, default=0.0)
        torch_ml_detected = torch_max >= THRESHOLD
        baseline_ml_detected = baseline_max >= THRESHOLD
        torch_pipeline = adjudicated_by_id[sample["id"]]
        torch_pipeline_detected = torch_pipeline["detected"]
        samples.append({
            "id": sample["id"], "category": sample["category"], "label": sample["label"],
            "text": sample["text"],
            "baseline_chunk_scores": old_scores,
            "pytorch_chunk_scores": torch_scores,
            "baseline_max_score": baseline_max,
            "pytorch_max_score": torch_max,
            "max_score_delta": torch_max - baseline_max,
            "max_abs_chunk_score_delta": max(
                (abs(a - b) for a, b in zip(old_scores, torch_scores)), default=abs(baseline_max - torch_max)
            ),
            "baseline_ml_detected": baseline_ml_detected,
            "pytorch_ml_detected": torch_ml_detected,
            "rule_detected": old["rule_detected"],
            "baseline_pipeline_detected": old["baseline_detected"],
            "pytorch_pipeline_detected": torch_pipeline_detected,
            "label_disagreement": baseline_ml_detected != torch_ml_detected,
            "pipeline_disagreement": old["baseline_detected"] != torch_pipeline_detected,
            "pytorch_finding_ids": torch_pipeline["finding_ids"],
            "pytorch_classifier_candidates": torch_pipeline["classifier_candidates"],
            "chunks_match": [
                {k: c[k] for k in ("start", "end", "token_count")}
                for c in chunks
            ] == [
                {k: c[k] for k in ("start", "end", "token_count")}
                for c in old["chunks"]
            ],
            "chunk_count": len(chunks),
            "inference_ms_per_chunk": per_item_latency[sample["id"]],
            "rule_finding_ids": old["rule_finding_ids"],
            "baseline_finding_ids": old["baseline_finding_ids"],
        })

    latencies = [item["inference_ms_per_chunk"] for item in samples]
    warm = latencies[1:] if len(latencies) > 1 else latencies
    disagreement_ids = [item["id"] for item in samples if item["label_disagreement"]]
    pipeline_disagreement_ids = [item["id"] for item in samples if item["pipeline_disagreement"]]
    max_deltas = [item["max_abs_chunk_score_delta"] for item in samples]
    return {
        "experiment": "Sentinel local ONNX versus same-revision PyTorch CPU reference",
        "model_id": MODEL_ID,
        "revision": REVISION,
        "license": "Apache-2.0",
        "checkpoint_sha256": "6521cb8d0ac08148c81464899c424e6148fcc62befa371089fa4061d8b6e0424",
        "frameworks": {
            "baseline": "@huggingface/transformers 4.3.1; ONNX Runtime CPU; existing Node app pipeline",
            "pytorch": f"torch {torch.__version__}; transformers {__import__('transformers').__version__}; CPU",
        },
        "preprocessing": {
            "max_tokens_including_special_tokens": MAX_TOKENS,
            "max_chunks": MAX_CHUNKS,
            "overlap_characters": OVERLAP_CHARS,
            "batch_size": BATCH_SIZE,
            "threshold": THRESHOLD,
            "offset_unit": "UTF-16 code units, matching JavaScript source offsets",
        },
        "dataset": {"id": corpus["dataset_id"], "sample_count": len(samples), "provenance": corpus["provenance"]},
        "baseline_full_pipeline_metrics": metrics(samples, "baseline_pipeline_detected"),
        "pytorch_plus_same_existing_pipeline_metrics": metrics(samples, "pytorch_pipeline_detected"),
        "baseline_model_only_metrics": metrics(samples, "baseline_ml_detected"),
        "pytorch_model_only_metrics": metrics(samples, "pytorch_ml_detected"),
        "parity": {
            "model_label_disagreement_count": len(disagreement_ids),
            "model_label_disagreement_ids": disagreement_ids,
            "pipeline_disagreement_count": len(pipeline_disagreement_ids),
            "pipeline_disagreement_ids": pipeline_disagreement_ids,
            "chunk_boundary_match_count": sum(x["chunks_match"] for x in samples),
            "max_absolute_score_delta": max(max_deltas, default=0.0),
            "mean_absolute_score_delta": statistics.mean(max_deltas) if max_deltas else 0.0,
            "exact_score_match_count": sum(x["max_abs_chunk_score_delta"] < 1e-6 for x in samples),
        },
        "latency": {
            "device": "CPU",
            "pytorch_model_load_seconds": model_load_seconds,
            "pytorch_per_chunk_ms_first_sample": latencies[0] if latencies else None,
            "pytorch_per_chunk_ms_warm_median_excluding_first": statistics.median(warm) if warm else None,
            "pytorch_per_chunk_ms_warm_p95_excluding_first": sorted(warm)[math.ceil(0.95 * len(warm)) - 1] if warm else None,
            "baseline_per_sample_ms_includes_first_worker_model_load": {
                "first": baseline["samples"][0]["inference_ms"] if baseline["samples"] else None,
                "warm_median_excluding_first": statistics.median([x["inference_ms"] for x in baseline["samples"][1:]]) if len(baseline["samples"]) > 1 else None,
            },
        },
        "special_cases": [x for x in samples if x["id"] in {"a18", "b13", "b14"}],
        "samples": samples,
        "limitations": [
            "This compares CPU ONNX and CPU PyTorch; it is not a ZeroGPU hardware, queue, cold-start, or Gradio integration test.",
            "The existing evaluation corpus is small and synthetic; metrics are not estimates of production accuracy.",
            "Score parity is measured but is not assumed; PyTorch and ONNX kernels and tokenizer implementations can differ numerically.",
            "PyTorch scores are adjudicated by the existing Node scanner and its deterministic/structural detectors; those detectors are not reimplemented in Python.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "results" / "comparison.json")
    args = parser.parse_args()
    result = run()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    summary = {k: result[k] for k in ("model_id", "revision", "dataset", "baseline_full_pipeline_metrics", "pytorch_plus_same_existing_pipeline_metrics", "parity", "latency", "special_cases")}
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
