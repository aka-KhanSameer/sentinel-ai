# Threat model

Assets: uploaded document bytes during parsing, extracted text, evidence excerpts, scan reports, optional local model and OCR data. Adversarial input includes malformed PDFs/ZIP/XML, archive bombs, oversized files, path traversal names, hidden Office/HTML instructions, prompt overrides, secrets exfiltration, encoded payloads, homoglyphs, and excessive scan requests.

Mitigations: file/text limits, signature-based parser routing, central-directory validation, ZIP entry/ratio/expansion limits, no archive extraction to filesystem, no uploaded code/macros/formulas executed, no external URL fetches, PDF page and image pixel limits, parser worker timeout and heap cap, bounded model chunks, local-only model loading, and HTML-escaped report content. Parser errors and OCR failure cannot be returned as clean scans. Temporary files are not created, so there is nothing to retain or clean up on normal parser paths. Worker termination is the timeout cleanup boundary.

Limits: in-memory results have no cross-user isolation; no authentication/rate limiting; native parser/OCR/model memory is not fully governed by the V8 heap limit; PDF color/hidden layers and Office rendering are incomplete; scanned PDF OCR is not active; model mode is optional and English-focused. Keep the service local and treat every document as untrusted regardless of score.
