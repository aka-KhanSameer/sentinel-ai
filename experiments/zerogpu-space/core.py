"""Sentinel-compatible text windows for the isolated ZeroGPU adapter."""
from __future__ import annotations

from typing import Any

MODEL_ID = "protectai/deberta-v3-base-prompt-injection-v2"
MODEL_REVISION = "90c9989b1a342275dd0d1a95aad283c04e075671"
THRESHOLD = 0.5
MAX_TOKENS = 480
MAX_CHUNKS = 256
OVERLAP_CHARS = 64
BATCH_SIZE = 4
MAX_TEXT_BYTES = 2 * 1024 * 1024


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


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
    regions: list[dict[str, int]] | None = None,
    max_tokens: int = MAX_TOKENS,
    max_chunks: int = MAX_CHUNKS,
    overlap_chars: int = OVERLAP_CHARS,
) -> dict[str, Any]:
    """Mirror backend/classifier.js and compare.py, including UTF-16 offsets."""
    units = _units(text)
    valid_regions = [
        {"start": r["start"], "end": r["end"]}
        for r in (regions or [])
        if isinstance(r, dict)
        and type(r.get("start")) is int
        and type(r.get("end")) is int
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


def build_result(text: str, chunks: list[dict[str, Any]], scores: list[float], truncated: bool) -> dict[str, Any]:
    if len(chunks) != len(scores):
        raise ValueError("Each source chunk must have exactly one model score")
    assessments = []
    for chunk, score in zip(chunks, scores):
        value = float(score)
        if not 0 <= value <= 1:
            raise ValueError("Model scores must be between zero and one")
        assessments.append({
            "start": chunk["start"],
            "end": chunk["end"],
            "token_count": chunk["token_count"],
            "injection_score": value,
            "decision_threshold": THRESHOLD,
            "label": "INJECTION" if value >= THRESHOLD else "SAFE",
        })
    scanned = assessments[-1]["end"] if assessments else 0
    total = utf16_length(text)
    return {
        "status": "partial" if truncated else "available",
        "mode": "zerogpu_classifier_partial" if truncated else "zerogpu_classifier",
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "threshold": THRESHOLD,
        "assessments": assessments[:32],
        "all_assessments": assessments,
        "coverage": {"characters": scanned, "total_characters": total, "ratio": scanned / total if total else 1.0},
        "truncated": truncated,
    }


def infer_document(text: str, tokenizer: Any, model: Any, *, regions=None, device="cpu") -> dict[str, Any]:
    """Run the pinned sequence classifier over Sentinel-aligned source windows."""
    import torch

    cut = split_like_sentinel(text, tokenizer, regions=regions)
    scores: list[float] = []
    injection_id = int(model.config.label2id["INJECTION"])
    for offset in range(0, len(cut["chunks"]), BATCH_SIZE):
        batch = cut["chunks"][offset:offset + BATCH_SIZE]
        encoded = tokenizer([item["text"] for item in batch], padding=True,
                            truncation=False, add_special_tokens=True, return_tensors="pt")
        if encoded["input_ids"].shape[1] > MAX_TOKENS:
            raise ValueError("Tokenizer window exceeded the pinned 480-token limit")
        encoded = {key: value.to(device) for key, value in encoded.items()}
        with torch.inference_mode():
            probabilities = torch.softmax(model(**encoded).logits, dim=-1)[:, injection_id]
        scores.extend(float(value) for value in probabilities.tolist())
    return build_result(text, cut["chunks"], scores, cut["truncated"])
