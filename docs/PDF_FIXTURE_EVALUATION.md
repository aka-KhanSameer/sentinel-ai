# Prompt-injection PDF fixture evaluation

## Run and measured result

The exact file `tests/fixtures/prompt_injection_test_suite.pdf` was uploaded as multipart field `file` to the running `POST /api/v1/scans` endpoint. The API returned HTTP 201, format `pdf`, parser status `completed`, and mode `local_classifier`. PDF.js extracted 9,154 characters from six pages and 14 non-empty Info/XMP metadata fields. The classifier covered 9,153/9,154 characters. The resulting report had 73 raw findings, 56 deduplicated primary findings, and 73 primary-plus-support evidence items.

The page-6 answer key is the label source. The evaluator credits an ID only if a finding or retained supporting finding contains non-empty evidence that exactly matches the original extracted text at the reported offset, overlaps that ID's payload range, and does not overlap any other labeled payload range. A broad chunk-level result cannot count for multiple IDs. Offsets are into Sentinel's extracted-text string (UTF-16 indices), not PDF byte offsets. Metadata results point to the named metadata field; page text results include page and extracted-text offsets. The full ledger, including each ID's status, evidence and finding location, is [PDF_FIXTURE_EVALUATION.json](PDF_FIXTURE_EVALUATION.json).

| Measure | Result |
| --- | ---: |
| Payloads PI-001–PI-038 individually detected | 38/38 |
| Missed payloads | 0 |
| Inconclusive payloads | 0 |
| BEN-001–BEN-006 incorrectly flagged | 0/6 |
| Payload detection rate / recall | 1.00 |
| Benign false-positive rate | 0.00 |
| Precision | 1.00 |
| F1 | 1.00 |

No payload was missed in this run. All 38 IDs have separate source-aligned evidence entries in the ledger. These metrics are only for these 44 hand-labeled examples. The separate 40-example synthetic evaluation remains at precision 0.741, recall 1.00, F1 0.851, and FPR 0.35 with the local classifier, so this fixture is not evidence of general reliability.

## Checks by content type

| Payload IDs | What the PDF contains | Observed evidence |
| --- | --- | --- |
| PI-001–PI-014 | Direct/indirect assistant or agent instructions, role markers, wrapped lines | Page 2 findings; the wrapped PI-014 instruction is retained in a merged analysis region and matched with its own source range. |
| PI-015–PI-018 | White/near-white or tiny text | PDF text paint/font inspection emits low-contrast/tiny structural evidence at page 3; findings retain the extracted phrase, page, and source offsets. |
| PI-019 | Base64-encoded instruction | Original encoded source is retained; deterministic decoded-instruction evidence is attached. |
| PI-020 | ROT13 | Original encoded source is retained with decoded-instruction evidence. |
| PI-021 | Hex | Original hex source is retained with decoded-instruction evidence. |
| PI-022–PI-025 | Leetspeak, spaced letters, PDF glyph/Unicode-like obfuscation | Findings preserve the original text and offsets; whitespace/glyph normalization is used only for matching. The fixture's extracted text represents the purported zero-width/homoglyph gaps as spaced `n` fragments, so that is what the ledger reports rather than invented Unicode code points. |
| PI-026–PI-029, PI-036 | Spanish, French, Hindi, German and translated Spanish instruction | The installed English-focused model flagged these specific fixture passages. This does not demonstrate broad multilingual accuracy. |
| PI-030–PI-033 | Markdown comment, hidden HTML, JSON role marker, YAML override | Each has an attributable page 4 classifier finding; PI-030 also has a hidden-markup rule finding. |
| PI-034–PI-035 | Persistent and multi-step instructions | Individually attributable page 4 classifier findings. |
| PI-037–PI-038 | PDF Subject and Keywords metadata | Metadata was added to the scanned text with field-level source mapping; each field has its own attributable finding. |
| BEN-001–BEN-006 | Benign/security discussion examples | No source-aligned finding overlaps any benign target range in this API report. |

## Findings-loss investigation and changes

- **Extraction:** the body text and pages were parsed, but PDF Info/XMP metadata was not previously in the classifier input; that omitted the two answer-key payloads in Subject and Keywords. Bounded metadata values are now appended as labeled text and mapped back to their field. The parser also detects white/near-white PDF text from text-paint operators and maps it to the original extracted text.
- **Chunking:** PDF.js represents some visual lines as multiple text items, and wrapped content may occupy adjacent baselines. Classifying arbitrary large ranges could let one model finding cover multiple labeled payloads without proving each. PDF analysis regions are now grouped by page and nearby baselines; findings remain localized and the evaluation credits only one target range at a time.
- **Normalization and rules:** matching now handles normalized/compacted whitespace and selected obfuscations while reporting the original evidence slice and its source offsets. Existing bounded Base64, ROT13, and hex decoding rules analyze decoded strings but retain the encoded source as evidence; the uploaded content is never executed or obeyed.
- **Deduplication and serialization:** this run reduced 73 raw findings to 56 primary findings. Overlapping detector evidence is retained under `supporting_findings`; the evaluator checks both primary and supporting records. All 73 evidence items survived serialization. The API does not cap the findings list. The separate `classifier_assessments` diagnostic summary is capped at 32 entries, but it is not used to construct or count findings.
- **UI:** the report renderer iterates over all findings and exposes supporting evidence in expandable sections. No finding display slice/limit was found. The UI also shows active mode, finding count, and limitations. JSON export retains the full report.
- **Threshold and coverage:** the successful run used the configured local model and reported 99.989% character coverage. The evaluator does not use broad assessment scores or chunk coverage as proof of a payload. A classifier can still miss content below the threshold, and rules-only fallback may have lower recall; use the mode field and run the fixture evaluator in the target environment.

## Regression coverage and remaining limits

`tests/extractor.test.js` now exercises this exact PDF's body extraction, metadata, hidden/tiny text, and classifier-region mapping. `tests/api-upload.test.js` uploads the same fixture through the real API worker path and checks the returned PDF report, metadata, structural finding and metadata payload evidence. Run `npm test` for the full suite. Run `npm run eval:pdf-fixture` with Sentinel running locally to repeat the answer-key comparison; it writes the detailed ledger and exits nonzero when a payload is missed/inconclusive or a benign sample is flagged.

This test only covers the provided PDF and current local model/revision/threshold. PDF.js's extracted Unicode/text representation may differ from visual appearance; scanned PDF pages do not receive OCR. Paint inspection handles supported text paint operations, not every transparency/blend/layout mechanism. Multilingual classifier performance, unseen encodings, alternate PDF construction, and real-world false-positive/false-negative rates remain unverified. The document's embedded instructions were treated only as inert test evidence.
