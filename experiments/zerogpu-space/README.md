---
title: Sentinel AI ProtectAI classifier
emoji: 🛡️
colorFrom: blue
colorTo: indigo
sdk: gradio
app_file: app.py
python_version: "3.12"
short_description: Pinned ProtectAI DeBERTa inference for Sentinel AI
---

# Sentinel AI · ProtectAI DeBERTa ZeroGPU

Private Gradio inference adapter for Sentinel AI. It accepts extracted text and source regions from the Sentinel API, applies the same pinned tokenizer, 480-token chunks, 64 UTF-16-unit overlap, 256-chunk cap and 0.5 threshold, then returns scores and source offsets. It never parses or executes uploaded files.

The checkpoint is the original Apache-2.0 `protectai/deberta-v3-base-prompt-injection-v2` revision `90c9989b1a342275dd0d1a95aad283c04e075671`. Startup verifies the pinned checkpoint digest and model labels/architecture. See `docs/ZEROGPU_PHASE1.md` in the Sentinel repository for the measured local ONNX/PyTorch parity results.

This is a best-effort portfolio service. Free ZeroGPU has daily quotas and shared queues; availability is not guaranteed. The Render API falls back to its deterministic and structural detectors when the Space sleeps, queues too long, or exhausts quota. Do not use it for sensitive documents.
