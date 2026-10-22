# ZeroGPU experiment — Phase 1: same-checkpoint PyTorch parity

**Status: local Phase 1 complete; no Space created and no live application changed.** This experiment checks whether Sentinel's existing pinned ProtectAI classifier can be loaded with PyTorch/Transformers using the original Safetensors checkpoint, with the existing chunking and scanner adjudication preserved. It does not test ZeroGPU, Gradio, GPU kernels, queueing, or deployment.

## Model identity and loading

- Model: `protectai/deberta-v3-base-prompt-injection-v2`
- Pinned revision: `90c9989b1a342275dd0d1a95aad283c04e075671` (the revision pinned by Sentinel's ONNX model downloader).
- Checkpoint: `model.safetensors`, 737,719,272 bytes; SHA-256 `6521cb8d0ac08148c81464899c424e6148fcc62befa371089fa4061d8b6e0424`.
- Architecture: `DebertaV2ForSequenceClassification`; DeBERTa-v2 base, 12 layers, 12 heads, hidden size 768, 512 maximum positions; labels `SAFE` (0) and `INJECTION` (1).
- License: Apache-2.0, verified from the license file at the pinned revision. The model card is English-focused and documents `AutoTokenizer`/`AutoModelForSequenceClassification` inference.
- The download script checks the resolved commit, Safetensors digest, and license before inference. Model files and the Python environment are ignored by Git; only the checksum manifest is tracked.

## Equivalent behavior tested

The PyTorch reference uses the same tokenizer files and matches Sentinel's current preprocessing: at most 480 tokens including special tokens per chunk; at most 256 chunks; 64-character overlap; line regions; batches of four; injection softmax score threshold 0.5. Chunk offsets are represented as UTF-16 code units, matching JavaScript. The Python scores are passed back into Sentinel's existing Node scanner, so its deterministic/structural corroboration policy is applied rather than treating every score above threshold as a confirmed finding.

The following paths are intentionally separate from production dependencies and runtime:

- `experiments/zerogpu-pytorch/compare.py` — PyTorch loading, chunking, inference, and comparison.
- `scripts/zerogpu-baseline.js` — per-sample ONNX baseline from the existing classifier worker and scanner.
- `scripts/zerogpu-adjudicate.js` — runs PyTorch scores through the unchanged production scanner logic.
- `experiments/zerogpu-pytorch/results/comparison.json` — per-sample baseline and PyTorch scores, decisions, findings, and latency.
- `experiments/zerogpu-pytorch/model-manifest.json` — pinned model/checkpoint/license manifest.

## Measured results

Run on the local Windows host with Python 3.12.14, CPU-only PyTorch 2.8.0, Transformers 4.39.3, Sentinel's `@huggingface/transformers` 4.3.1 + ONNX Runtime CPU, and the 40-item synthetic held-out `sentinel-synthetic-eval-v2` dataset. This dataset is small and is not representative of real-world performance.

| Measure | ONNX baseline | PyTorch reference |
|---|---:|---:|
| Model-only confusion (TP / FP / TN / FN) | 17 / 7 / 13 / 3 | 17 / 7 / 13 / 3 |
| Model-only precision / recall / F1 / false-positive rate | 0.708 / 0.850 / 0.773 / 0.350 | 0.708 / 0.850 / 0.773 / 0.350 |
| Full pipeline confusion (TP / FP / TN / FN) | 19 / 1 / 19 / 1 | 19 / 1 / 19 / 1 |
| Precision / recall / F1 / false-positive rate | 0.950 / 0.950 / 0.950 / 0.050 | 0.950 / 0.950 / 0.950 / 0.050 |
| Model label disagreements | — | 0 of 40 |
| Full scanner decision disagreements | — | 0 of 40 |
| Chunk boundary matches | — | 40 of 40 |
| Exact per-sample max-score matches (absolute delta < 1e-6) | — | 38 of 40 |
| Maximum / mean absolute score delta | — | 9.75e-6 / 3.48e-7 |

Per-sample scores and all sample IDs are recorded in `results/comparison.json`. The only score deltas at or above 1e-6 were benign samples `b09` (ONNX 0.37989509; PyTorch 0.37988535; delta 9.745e-6) and `b20` (ONNX 0.08412818; PyTorch 0.08412543; delta 2.749e-6). Neither changed its threshold decision. The score outputs are therefore numerically very close on this corpus, but are not asserted to be bit-identical.

The standalone classifier's three false negatives are `a06` (secret exfiltration), `a07` (tool manipulation), and `a13` (encoded obfuscation). Its seven false positives are `b03`, `b05`, `b06`, `b11`, `b13`, `b14`, and `b17`. Existing deterministic/structural handling rescues the three attack cases in the complete pipeline, and candidate adjudication suppresses six of the seven model-only benign positives. The full pipeline still has one false positive (`b14`) and one false negative (`a18`).

### Known multilingual miss and quoted-attack false positive

- `a18`, Spanish instruction: both model implementations assign an injection score above 0.999999. The API-style scanner still does **not** confirm it: no Spanish deterministic rule overlaps the source, so the high score remains an unconfirmed classifier candidate and the sample is an end-to-end false negative. This is an arbitration/language-coverage limitation, not a PyTorch-vs-ONNX disagreement.
- `b13`, benign discussion of a detector test: both models also score it above 0.999999, but the scanner correctly leaves it as an unconfirmed candidate because there is no independent rule evidence.
- `b14`, benign lab-handout quote: both models score it above 0.999999. The deterministic normalization path also emits `leet_instruction` for the plain-text phrase `ignore previous instructions`; it does not apply the benign-context exclusion on that path. That evidence corroborates the ML score and produces the corpus's one pipeline false positive. This known rules/context issue is documented, not silently corrected by the experiment.

### Latency (CPU only)

- PyTorch model load: 0.544 s; first sample forward pass: 941 ms; warm per-chunk median: 112.7 ms; warm p95: 151.4 ms.
- ONNX baseline warm per-sample median: 34.7 ms. Its first call was 3,292 ms and includes worker/model initialization, so that cold measurement is not directly comparable to PyTorch's separately timed model load.
- On this CPU host, warm PyTorch inference was about 3 times slower than warm ONNX. A ZeroGPU CUDA speedup is plausible but **unmeasured**.

## Reproduce locally (Windows PowerShell)

Requirements: Python 3.12 x64, Node.js 22.13+, Git/network access to Hugging Face and the PyPI/PyTorch CPU wheel index, approximately 1.5 GB free disk for the Python environment and checkpoint. No Hugging Face token is needed for this public model.

```powershell
py -3.12 -m venv experiments\zerogpu-pytorch\.venv
$Python = 'experiments\zerogpu-pytorch\.venv\Scripts\python.exe'
& $Python -m pip install --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple -r experiments\zerogpu-pytorch\requirements-lock.txt
$env:HF_HOME = 'experiments/zerogpu-pytorch/.cache'
& $Python experiments\zerogpu-pytorch\download_model.py
npm run eval:zerogpu-baseline
& $Python -m pytest experiments\zerogpu-pytorch\tests -q
& $Python experiments\zerogpu-pytorch\compare.py
```

The download is about 738 MB for `model.safetensors` plus tokenizer/config files. It lands in the ignored `experiments/zerogpu-pytorch/model/` directory. The generated full comparison is written to `experiments/zerogpu-pytorch/results/comparison.json`.

## Phase 1 conclusion

**The same pinned Safetensors checkpoint runs locally through PyTorch/Transformers, and this 40-sample comparison preserves chunking, per-sample labels, scanner decisions, and measured scores closely.** The Python CPU implementation is slower than the existing ONNX CPU runtime on this host. This validates a candidate implementation path; it does not establish CUDA/ZeroGPU compatibility, production latency, queue/cold-start behavior, or operational reliability.

## Phase 2 adapter preparation (2026-10-22)

The isolated `experiments/zerogpu-space/` directory contains a minimal Gradio app and a small inference core. The core reuses the same pinned model/tokenizer, threshold, 480-token limit, 64-character overlap, 256-chunk cap, UTF-16 source offsets, and four-item batching. Startup verifies the model revision's Apache-2.0 license, architecture/labels, and checkpoint SHA-256. It returns per-chunk scores and offsets only; it does not echo extracted text or handle files.

The existing Render API now has an optional queued Gradio client, activated only when both `HF_SPACE_URL` and server-side `HF_TOKEN` are set. It submits extracted text/source regions to the private Space, checks model identity and offsets, and reports external transfer. HTTP errors, queue/quota exhaustion, invalid responses, 65-second timeouts, and text above 2 MiB produce an explicit rules-only fallback. The Vercel frontend shows whether ZeroGPU is configured and warns that extracted text goes to Hugging Face. API readiness does not imply the remote model is healthy; capabilities label it `remote_configured_unverified`.

**Local checks are not a ZeroGPU deployment check.** The mock queue integration uploads the actual test PDF through the local API/parser and exercises the report mapping, but its inference response is synthetic. The Space has not been created, its GPU startup/inference has not run, and the live Render/Vercel services have not been switched. Current Hugging Face docs list Gradio + PyTorch 2.8+ support and free ZeroGPU for eligible personal accounts; the free account quota is five GPU minutes/day and shared queues can delay or reject work. This is consequently only a best-effort model option, with the existing Render rules-only path as the working fallback. Deployment requires the manual private Space and read-token setup in `docs/DEPLOYMENT.md`.
