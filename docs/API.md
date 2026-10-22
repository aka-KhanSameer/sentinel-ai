# API reference

All routes use `/api/v1`. JSON error shape: `{ "error": { "code": "...", "message": "..." } }`; internal exceptions and stack traces are not returned.

- `GET /health`, `/readiness`: minimal process/dependency state.
- `GET /capabilities`: accepted formats, configured limits, OCR availability, classifier status, model revision/license, missing model files, and fallback mode.
- `POST /scans/text`: JSON `{ "text": string }`; bounded by `MAX_TEXT_BYTES`.
- `POST /scans`: multipart field `file`; bounded by `MAX_UPLOAD_BYTES`. Content signature chooses supported PDF, Office, image, or text parser. A filename suffix is not trusted as the type.
- `GET /scans`: in-memory recent reports.
- `GET /scans/{scan_id}` and `/scans/{scan_id}/report`: current-process JSON report.

Reports retain the original response fields and add `summary.classifier`, `summary.classifier_coverage`, `summary.classifier_assessments`, parser format/status, optional OCR metadata, and detector provenance. Findings contain source, original evidence, severity, heuristic/model score note, explanation, and locations (line/page/paragraph/sheet/slide/OCR box where available).

Status examples: 400 malformed request, 413 size/page/archive/image limit, 415 unsupported content signature, 408 parser timeout, 422 malformed document, 503 configured OCR unavailable. Parser or required extraction failures return errors and do not create a clean report. Missing ML is not a scan failure: response explicitly says `rules_only_fallback` and rules/structure continue. Scan records vanish on process restart. No authentication or rate limiting is implemented; do not expose publicly.
