# API reference

All routes use `/api/v1`. JSON error shape: `{ "error": { "code": "...", "message": "..." } }`; internal exceptions and stack traces are not returned.

- `GET /health`, `/readiness`: minimal process/dependency state.
- `GET /capabilities`: accepted formats, configured limits, OCR availability, classifier status, model revision/license, missing model files, and fallback mode. Optional ZeroGPU reports `ml_provider: "huggingface_zerogpu"`, `ml_status: "remote_configured_unverified"`, and `remote_text_transfer`; these fields show configuration only, not a successful provider health check.
- `POST /scans/text`: JSON `{ "text": string }`; bounded by `MAX_TEXT_BYTES`.
- `POST /scans`: multipart field `file`; bounded by `MAX_UPLOAD_BYTES`. Content signature chooses supported PDF, Office, image, or text parser. A filename suffix is not trusted as the type.
- `GET /scans`: in-memory recent reports.
- `GET /scans/{scan_id}` and `/scans/{scan_id}/report`: current-process JSON report.

Reports retain the original response fields and add `summary.classifier`, `summary.classifier_coverage`, `summary.classifier_assessments`, parser format/status, optional OCR metadata, and detector provenance. Findings contain source, original evidence, severity, heuristic/model score note, explanation, and locations (line/page/paragraph/sheet/slide/OCR box where available).

Status examples: 400 malformed request, 413 size/page/archive/image limit, 415 unsupported content signature, 408 parser timeout, 422 malformed document, 503 configured OCR unavailable. Parser or required extraction failures return errors and do not create a clean report. Missing or unavailable optional ML is not a scan failure: response explicitly says `rules_only_fallback` and rules/structure continue. When configured, the API sends extracted text and source ranges—not uploaded file bytes—to the private Hugging Face Space; tokens are backend-only. Free quota, queue, and timeout failures are reported and fall back. Scan records vanish on process restart. The public portfolio demo's rate limit is process-local, so do not treat this prototype as a production security boundary.
