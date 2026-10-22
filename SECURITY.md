# Security policy

Sentinel reports evidence and prioritization estimates. It cannot prove malicious intent, certify safety, or prevent injection. A low score must not authorize execution. Keep the unauthenticated prototype on a trusted local machine; do not publish it on a network.

Uploads are bounded, signature-checked, processed in isolated Node worker threads, and never executed or written to temporary files. Office ZIP contents are checked for traversal names, encryption, entry count, compression method, ratio, declared and actual expansion. Parsing has a timeout and worker heap cap. URLs in content are not fetched. HTML and report evidence are rendered as escaped text. XLSX formulas are read as strings; macros and embedded code are not run. OCR requires local traineddata, and model inference uses local files only.

Supported formats and known limits are listed in README.md and `/api/v1/capabilities`. Evidence excerpts remain in ephemeral in-process scan history until restart. There is no authentication, durable data isolation, or rate limiting. Do not upload confidential content to a shared instance.

Report security issues privately to the project owner without including real secrets or personal information.
