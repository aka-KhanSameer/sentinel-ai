"""Minimal Gradio/ZeroGPU endpoint for the exact Sentinel ProtectAI checkpoint."""
from __future__ import annotations

import hashlib
from pathlib import Path

import gradio as gr
import spaces
import torch
from huggingface_hub import hf_hub_download, snapshot_download
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from core import (
    MAX_TEXT_BYTES, MODEL_ID, MODEL_REVISION,
    infer_document,
)

WEIGHT_SHA256 = "6521cb8d0ac08148c81464899c424e6148fcc62befa371089fa4061d8b6e0424"
torch.set_num_threads(2)


def load_model():
    directory = Path(snapshot_download(
        repo_id=MODEL_ID,
        revision=MODEL_REVISION,
        allow_patterns=["LICENSE", "config.json", "tokenizer.json", "tokenizer_config.json",
                        "special_tokens_map.json", "added_tokens.json", "spm.model", "model.safetensors"],
    ))
    license_text = (directory / "LICENSE").read_text(encoding="utf-8")
    if "Apache License" not in license_text or "Version 2.0" not in license_text:
        raise RuntimeError("Pinned model license check failed")
    weights = hf_hub_download(MODEL_ID, "model.safetensors", revision=MODEL_REVISION)
    digest = hashlib.sha256()
    with open(weights, "rb") as checkpoint:
        for block in iter(lambda: checkpoint.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != WEIGHT_SHA256:
        raise RuntimeError("Pinned Safetensors checkpoint digest did not match")

    tokenizer = AutoTokenizer.from_pretrained(str(directory), local_files_only=True,
                                               use_fast=True, trust_remote_code=False)
    model = AutoModelForSequenceClassification.from_pretrained(
        str(directory), local_files_only=True, use_safetensors=True, trust_remote_code=False
    )
    if model.__class__.__name__ != "DebertaV2ForSequenceClassification":
        raise RuntimeError("Unexpected model architecture")
    if model.config.id2label != {0: "SAFE", 1: "INJECTION"}:
        raise RuntimeError("Unexpected model labels")
    if not tokenizer.is_fast:
        raise RuntimeError("Pinned fast tokenizer is required")
    model.eval()
    # ZeroGPU's documented pattern: CUDA placement at module startup, GPU work inside @spaces.GPU.
    model.to("cuda")
    return tokenizer, model


tokenizer, model = load_model()


@spaces.GPU(duration=25)
def score_document(text: str, regions: list[dict] | None):
    if not isinstance(text, str):
        raise gr.Error("Expected extracted document text.")
    if len(text.encode("utf-8", errors="surrogatepass")) > MAX_TEXT_BYTES:
        raise gr.Error("Extracted text exceeds the ZeroGPU adapter's 2 MiB request limit.")
    if regions is not None and not isinstance(regions, list):
        raise gr.Error("Source regions must be a list.")
    if regions is not None and len(regions) > 20_000:
        raise gr.Error("Too many source regions.")
    try:
        result = infer_document(text, tokenizer, model, regions=regions, device="cuda")
    except ValueError as error:
        raise gr.Error(str(error)) from error
    # Per-chunk scores and offsets are returned; extracted text is not echoed.
    return result


demo = gr.Interface(
    fn=score_document,
    inputs=[gr.Textbox(label="Extracted text", lines=2), gr.JSON(label="Source regions (optional)")],
    outputs=gr.JSON(label="Pinned ProtectAI DeBERTa scores"),
    api_name="score",
    title="Sentinel AI · ProtectAI DeBERTa",
    description="Private inference adapter. Extracted text is sent by Sentinel's backend; source files are not uploaded here.",
)
demo.queue(default_concurrency_limit=1, max_size=16).launch()
