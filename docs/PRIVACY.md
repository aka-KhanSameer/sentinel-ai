# Privacy

Uploaded content is parsed and scanned in local worker threads. The API does not write uploads to disk or send content to a third party. OCR and classifier weights are local; classifier remote model loading is disabled. Scan history contains report metadata and short evidence excerpts in process memory and disappears on restart. The full source document is not persisted.

OCR requires a locally installed language file. The optional classifier downloads only when an operator explicitly runs `npm run model:download`; subsequent inference runs locally. Reports can contain sensitive excerpts and are retrievable by anyone with access to this local unauthenticated service. Keep it bound to loopback. There is no multi-user isolation or configurable retention store yet. Production use requires authentication, TLS, access logging without document contents, user notice, secure storage, and deletion controls.
