# Sentinel AI upgrade checklist

## Priority 1 — secure document extraction

- [x] Preserve the existing text scan API and dashboard.
- [x] Add content-signature routing, PDF.js text extraction with page/position mapping, DOCX paragraphs/comments/notes and hidden-run evidence, XLSX cells/formulas/hidden rows/sheets, PPTX slides/notes and style evidence, and PNG/JPEG/WebP OCR with bounding boxes.
- [x] Add 5 MiB default upload bound, 100-page PDF cap, 256 archive-entry/32 MiB expansion/100:1 ratio caps, 20-million-pixel image limit, ZIP path traversal/encryption/malformed-file checks, parser worker memory/timeout limits, and no temporary-file writes or execution.
- [x] Add malformed/unsupported file, archive bomb, parser timeout, oversize API, source mapping, and upload-to-report tests.
- [x] Download and verify pinned official English tessdata; verify an actual synthetic image OCR result.
- [ ] Scanned-PDF OCR, PDF font-color inspection, Office rendering, embedded objects, and complete structural semantics remain unsupported and documented.

## Priority 2 — local ML classifier

- [x] Verify and pin ProtectAI DeBERTa v3 prompt-injection model card/revision/license and documented ONNX text-classification interface.
- [x] Add checksum-verifying model downloader, offline-only local Transformers.js inference, token-bounded overlapping chunks, raw score/threshold reporting, lazy single-worker loading, timeout, and rules-only fallback signaling in API/UI.
- [x] Downloaded and checksum-verified the ~739 MB weights; actual CPU inference ran through upload-to-report and the synthetic evaluation pipeline.
- [x] Preserve deterministic and structural scanning when the model is missing or unavailable; never call rules-only mode AI detection.

## Priority 3 — evidence aggregation

- [x] Combine rules, optional model findings, and parser structural evidence with provenance and explanations.
- [x] Deduplicate overlapping evidence for risk aggregation; retain distinct detector evidence in reports.
- [x] Add benign-context exclusions, Unicode homoglyph/invisible-character folding, and bounded Base64/percent-decoding checks with original evidence preserved.

## Priority 4 — evaluation

- [x] Expand a separate synthetic held-out evaluation set to 40 diverse benign/malicious examples with multilingual, hidden-content, and obfuscated cases.
- [x] Add benign, obfuscation, known false-negative, parser-failure, and upload workflow tests.
- [x] Measure and report actual rules-only fallback metrics (see docs/EVALUATION.md); do not present them as generalizable performance.
- [x] Re-ran the current combined local-ML pipeline (n=40; TP=19, FP=1, TN=19, FN=1; precision/recall/F1 0.95, FPR/FNR 0.05); the Spanish miss and benign quoted-instruction false positive are documented in `docs/EVALUATION.md`.
- [x] Upload and evaluate the exact six-page PI-001–PI-038/BEN-001–BEN-006 PDF fixture against its page-6 answer key; retain payload-specific source evidence/offsets in `docs/PDF_FIXTURE_EVALUATION.json` and parser/API regression coverage in `tests/`.

## Priority 5 — product/docs

- [x] Update dashboard/API capabilities to show active detector mode and classifier coverage.
- [x] Update README, SECURITY, API/architecture/threat/evaluation/deployment/privacy docs, CI, Docker build recipe, and this checklist.
- [ ] Docker image build is unverified because Docker is not installed in this environment.

Workspace constraints at the initial implementation: `rtk` and Python were not on PATH. This session used the bundled Python 3.12 runtime only for the isolated local PyTorch feasibility experiment; production remains Node.js with pinned npm dependencies. No live service was changed by that experiment.

## Hugging Face ZeroGPU local experiment — Phase 1 (2026-10-22)

- [x] Downloaded and SHA-256 verified the exact pinned ProtectAI `model.safetensors` checkpoint (Apache-2.0) without adding files to production model/runtime paths.
- [x] Added isolated PyTorch/Transformers CPU reference, exact Sentinel-style UTF-16 chunking, baseline and scanner-adjudication scripts, tests, and per-sample result JSON under `experiments/zerogpu-pytorch/`.
- [x] Benchmarked all 40 existing evaluation samples: 0/40 model label disagreements, 0/40 pipeline decision disagreements, 40/40 chunk-boundary matches; full pipeline metrics remained TP=19, FP=1, TN=19, FN=1.
- [x] Documented the multilingual false negative, benign quoted-attack false positive, measured score deltas and CPU latency in `docs/ZEROGPU_PHASE1.md`.
- [ ] Phase 2 ZeroGPU Gradio/GPU compatibility, hosting, queue/quota behavior, and deployment remain untested. Do not route the live API to ZeroGPU until those checks pass.

## Northwind PDF forensic follow-up (2026-10-22)

- [x] Preserve the supplied PDF, answer key, and saved baseline JSON under `tests/fixtures/`.
- [x] Trace old structural status: `scanText` inferred structural applicability only from emitted structural findings/invisible characters. Successful execution of PDF structural inspection was not represented as applicability; an empty result became `not_applicable`. Several parser subpaths suppressed exceptions. This was a status/control-flow defect, not evidence that the file lacked inspectable structure.
- [x] Add PDF parser stage diagnostics, custom Info Map/XMP field enumeration, annotations/URI extraction, span geometry, paint color/font/opacity, off-page text recovery from the operator list, and simple later opaque rectangle coverage. Keep failed optional paths distinct and continue unrelated extraction.
- [x] Add generic target/action detection and reversed-text probing; retain source evidence and offsets. Classifier candidates without an exact source-evidence overlap with an independent rule no longer corroborate or affect risk. Risk no longer increases from raw model scores; structural-only observations stay informational/low.
- [x] Add exact Northwind parser assertions and the actual multipart API upload regression.
- [x] Add multipart upload assertions for all recoverable target IDs and exact PDF source assertions for the eight hard-negative sentences. Deterministic rules flagged 0/8 isolated HN passages; final API-level HN scoring and all ordinary prose scoring remain unimplemented.
- [x] Recover cross-page X-02 through the API and preserve target token IDs in supporting findings during deduplication.
- [x] Bind the generic target-action rule to low-contrast X-09 and retain the target token through final evidence aggregation.
- [ ] X-12 remains unresolved: PDF.js exposes no text for the CJK glyph sequence; UTF-16BE ASCII token bytes follow opaque glyph bytes in the content stream, but the Chinese instruction itself is not reconstructed. Do not count as detected.
- [x] Add and run a separate 10-item paraphrase/benign rules-only evaluation. Result: TP=4, FN=2, TN=4, FP=0; precision 1.00, recall 0.67, F1 0.80, FPR 0.00. U-01 and U-03 were missed. This small suite is not representative.
- [ ] Verify classifier-only candidate scores and full-document false positives on supplied HN-01..08 against the final API evidence; current HN tests cover deterministic rules in isolated passages only.

The parser/rule scan and API upload tests each verify 19/20 payload IDs (95% detection): X-12 is the remaining miss. The eight HN source sentences are verified benign for deterministic rules in isolation (0/8 flagged); this is not a full-document/API false-positive-rate estimate. No precision or F1 is reported. The API reports structural analysis as completed when PDF geometry inspection executes, with detailed parser stages; an actual stage error marks the overall analysis partial.
