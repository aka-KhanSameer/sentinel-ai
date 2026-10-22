# Free portfolio deployment — Vercel + Render

This is a hobby demonstration with a hard $0/month hosting target. The live baseline is a static frontend on Vercel Hobby and a Node.js API on Render Free. Until the optional Hugging Face ZeroGPU section below is completed, the API uses deterministic rules and document-structure checks only; it does **not** load the project's 739 MB ProtectAI DeBERTa model. Rule matching is not described as AI. No managed database or persistent disk is used.

## Current status

- GitHub source: [`aka-KhanSameer/sentinel-ai`](https://github.com/aka-KhanSameer/sentinel-ai), branch `main`.
- Vercel Hobby frontend: [https://sentinel-ai-pearl-mu.vercel.app](https://sentinel-ai-pearl-mu.vercel.app), deployed from `main`.
- Render Free API: [https://sentinel-ai-api-lduk.onrender.com](https://sentinel-ai-api-lduk.onrender.com), service `sentinel-ai-api`, deployed from commit `4a3a905` (deployment `dep-dbcu9f3l550s73d4sh10`). The selected resources are free tier; no database, disk, paid compute, or trial was created.
- Live checks on 2026-10-22: frontend loaded and fetched capabilities; `/api/v1/health` returned `{"status":"ok"}`; `/api/v1/readiness` returned ready with `storage: "session_ephemeral"`; capabilities reported public demo mode, no ML classifier, no OCR, and a 2 MiB upload limit. The exact Vercel origin is configured in Render CORS.
- A real browser upload of `tests/fixtures/prompt_injection_test_suite.pdf` completed through the public frontend. The UI rendered a PDF report with parser status completed, overall analysis partial, rules-only mode, 22 findings, and risk 100/100. This is an end-to-end workflow smoke check, not a measured per-payload accuracy result. The uploaded file is processed in memory; the test does not verify persistence or classifier quality.
- Current local verification (2026-10-22): 37/37 Node tests passed, including a mocked queued-inference actual-PDF upload flow; the frontend build passed; `npm run eval` measured the existing 40-sample local ONNX pipeline at precision/recall/F1 0.95 and FPR 0.05; `npm run eval:northwind` retained its 10-item rules-only result (precision 1.00, recall 0.67, F1 0.80, FPR 0.00); Phase 1 plus ZeroGPU-adapter Python tests passed 8/8. These local tests do not prove hosted ZeroGPU inference.
- PostgreSQL is not provisioned, so no production database migration was run. Session report/history storage is ephemeral and may disappear after a restart or spin-down.

## Optional Hugging Face ZeroGPU

**Current state: adapter and backend proxy are prepared and tested locally; no Hugging Face Space is created or live.** Until a Space is created and its two Render environment settings are added, the current Render/Vercel deployment remains the existing rules-only demo. Vercel still sends uploads directly to Render. Render parses the file locally, then (only when configured) sends extracted text and source ranges to the private Hugging Face Space. The Space returns the original pinned ProtectAI model's per-chunk scores; source mapping, rules, structure, deduplication, and report generation remain in Sentinel's Node API.

The Phase 1 comparison used the exact ProtectAI checkpoint at `90c9989b1a342275dd0d1a95aad283c04e075671`, SHA-256 `6521cb8d0ac08148c81464899c424e6148fcc62befa371089fa4061d8b6e0424`, with Apache-2.0 license and `DebertaV2ForSequenceClassification` architecture. The same-revision PyTorch CPU path matched the production ONNX classifier's labels and final scanner decisions on all 40 synthetic evaluation items (score differences were small but nonzero). The separate Space app verifies the checkpoint digest, model labels, architecture, and license at startup. No ZeroGPU hardware inference has yet been demonstrated in this account.

Current Hugging Face documentation says a personal account in good standing with verified email and age over 30 days can host up to two ZeroGPU Spaces free. ZeroGPU supports Gradio and PyTorch 2.8+, uses 48 GB VRAM in its default large allocation, and has a **5 GPU-minute/day free account quota** that resets 24 hours after first use. Queues and account quota affect service; this is a portfolio experiment, not a reliable always-on classifier. Authenticated requests use the Hugging Face token owner's quota. No paid plan, billing credits, paid GPU, or other paid resource is required or should be enabled. See [ZeroGPU compatibility, quota, and eligibility](https://huggingface.co/docs/hub/spaces-zerogpu) and [Spaces queue API](https://huggingface.co/docs/hub/en/spaces-api-endpoints).

### Manual Hugging Face setup

1. Sign into a **personal free** Hugging Face account. Confirm the email is verified and the account is at least 30 days old. If the account is not eligible for free ZeroGPU hosting, stop; do not start a trial or choose paid hardware.
2. Create one new Space named `sentinel-ai-zerogpu`, set visibility to **Private**, select **Gradio**, Python **3.12**, and the **ZeroGPU** shared hardware option (`zero-a10g` / ZeroGPU large). Do not select dedicated T4/L4/A10G hardware, subscribe, add billing credits, or attach paid storage. If Hugging Face presents a payment/upgrade screen, stop and leave the live demo unchanged.
3. From the repository root, upload just the four files under `experiments/zerogpu-space/` to the Space repository root. The model is downloaded from its pinned public revision at Space startup; do not upload or commit model weights.

   If using the Hugging Face CLI, install it in a separate local Python environment, sign in at the terminal's secure prompt (do not paste the token into ChatGPT), then run:

   ```powershell
   hf auth login
   hf upload <your-namespace>/sentinel-ai-zerogpu experiments/zerogpu-space . --repo-type space
   ```

   Wait for the Space build to finish. Its initial startup downloads the pinned 738 MB checkpoint and verifies the digest. Confirm Space Settings still say private and ZeroGPU before proceeding.
4. Create a Hugging Face fine-grained token that grants **read access only** to that private Space. Do not grant billing permissions. Add these in the existing Render service's Environment page (not Vercel and not GitHub):

   | Key | Value |
   |---|---|
   | `HF_SPACE_URL` | `https://<your-namespace>-sentinel-ai-zerogpu.hf.space` |
   | `HF_TOKEN` | Fine-grained read token for that private Space (secret) |

   Save and redeploy the existing `sentinel-ai-api` service. Keep `PUBLIC_DEMO_MODE=true`, `REQUIRE_LOCAL_CLASSIFIER=false`, and all existing free-plan safeguards unchanged. Do not paste the token into chat, logs, a commit, or the Vercel project.
5. `GET /api/v1/capabilities` should report `ml_provider: "huggingface_zerogpu"` and `ml_status: "remote_configured_unverified"`. This is configuration visibility only; it does not prove the Space is healthy or that inference works. Upload a non-sensitive PDF from the public frontend and verify the report's classifier mode, source-aligned finding/candidate offsets, and detector diagnostic `remote_zerogpu_classifier`. The report discloses that extracted text was sent to Hugging Face.

The Render proxy has a 65-second queue timeout, sends no file bytes (only extracted text/regions), does not log document text or the token, rejects wrong model revisions and invalid offsets, and falls back to rules/structural analysis on HTTP errors, quota/queue failures, timeout, incompatible responses, or extracted text over 2 MiB. Fallback is represented in the scan API report and UI. One authenticated Render proxy shares the account owner's small daily quota across all visitors; on quota exhaustion, scans remain available as explicitly labelled rules-only fallback until the provider quota resets. Initial model download/startup, cold starts, public Render sleeping, queue wait, network availability, and quota all make this **best-effort**, not guaranteed. A request can time out and fall back even while the Space is still starting.

Until those manual steps are completed and a live PDF scan is verified, the only confirmed live capability is the existing rules-only demo documented above. A mocked local queue test is not live ZeroGPU verification.

## Why the full classifier is off in the free deployment

Render Free currently provides 0.1 CPU and 512 MB RAM, spins down after 15 minutes idle, loses local files on restart/redeploy/spindown, and has no persistent disk. The pinned DeBERTa ONNX file alone is about 739 MB. A current smaller candidate, `nodd-repo/prompt-injection` v3, advertises an 18.58 MB int8 ONNX artifact under Apache-2.0 with a Transformers.js interface, but its reported test set is only 52 items and has not been benchmarked or integrated into Sentinel. Another compact candidate, ZeroLeaks Shield Small (118 MB int8 ONNX), uses CC BY-NC 4.0 weights, so it is not selected for this public portfolio deployment. We will not silently switch models or infer that a model is reliable or compatible based on size alone.

References: [Render Free limits](https://render.com/docs/free), [Render compute plans](https://render.com/docs/compute-plans), [nodd model card](https://huggingface.co/nodd-repo/prompt-injection), [ZeroLeaks Shield Small model card and license](https://huggingface.co/ZeroLeaks/shield-small).

## Create the Vercel frontend (Hobby, $0)

1. Sign in to the existing Vercel Hobby workspace and import the existing private GitHub repository `aka-KhanSameer/sentinel-ai`. Do not create a second project if `sentinel-ai` already appears in the workspace.
2. Select the repository root (`.`), branch `main`, Framework Preset **Other**, install command `npm ci`, build command `npm run build:frontend`, and output directory `frontend` (also defined by `vercel.json`).
3. Do not add secrets. `PUBLIC_API_BASE_URL` is public build-time config. After creating the Render service, set it to `https://<actual-render-host>/api/v1` and redeploy the frontend.
4. Keep only the default HTTPS `vercel.app` domain for this portfolio demo. Vercel serves static files; uploads go directly from the browser to Render and bypass Vercel Functions.

### Vercel Hobby private-repository author check

Vercel Hobby can block an otherwise valid production deployment when the latest Git commit's author is not the owner of the Vercel project. Keep the repository private and the plan free: make commits with the project owner's verified GitHub identity (for this repository, `105150944+aka-KhanSameer@users.noreply.github.com`) and confirm GitHub associates that address with `aka-KhanSameer`. Do not solve this by upgrading or making the repository public. Check the Vercel deployment page after every push; a Git push succeeding does not mean Vercel published the commit.

## Create the Render API (Free, $0)

1. In Render, create one Web Service from the existing private GitHub repository, branch `main`. Choose the **Node** runtime (not Docker), Oregon or another available region, and the **Free: $0 / 512 MB** compute option. If Free is unavailable without adding payment details, stop and report that account restriction; do not choose a paid plan or trial.
2. Build Command: `npm ci`
3. Start Command: `npm start`
4. Health Check Path: `/api/v1/readiness`
5. Do not attach a disk. Do not create PostgreSQL or Key Value. Do not configure a pre-deploy migration command.
6. Configure these environment values:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PUBLIC_DEMO_MODE` | `true` |
| `REQUIRE_LOCAL_CLASSIFIER` | `false` |
| `REQUIRE_DATABASE` | `false` |
| `CORS_ORIGINS` | Exact deployed Vercel origin, currently `https://sentinel-ai-pearl-mu.vercel.app` (no trailing slash) |
| `MAX_UPLOAD_BYTES` | `2097152` (2 MiB, below the application’s default limit for the constrained free instance) |
| `MAX_TEXT_BYTES` | `262144` |
| `MAX_PROCESSING_MS` | `20000` |
| `MAX_CONCURRENT_SCANS` | `1` |
| `PARSER_OLD_HEAP_MB` | `192` |
| `PARSER_YOUNG_HEAP_MB` | `32` |
| `RATE_LIMIT_WINDOW_MS` | `60000` |
| `RATE_LIMIT_REQUESTS` | `10` |
| `TRUST_PROXY` | `true` |
| `SESSION_REPORT_TTL_MS` | `900000` |
| `MAX_SESSION_REPORTS` | `10` |

Leave `DATABASE_URL`, model paths, OCR paths, and `PORT` unset. Render supplies `PORT`; model and OCR are unavailable in this deployment. No migration runs because no database exists.

7. After Render shows the service URL and a successful deploy, use its exact `onrender.com` URL in the Vercel `PUBLIC_API_BASE_URL`. Redeploy Vercel. Copy the final Vercel production origin into Render `CORS_ORIGINS` and save/redeploy the API if the actual hostname differs from what was initially entered. CORS allows credentials only from explicitly configured origins.

## API behavior and demo limitations

- `/api/v1/health` is liveness. `/api/v1/readiness` reports API readiness; `/api/v1/capabilities` exposes `public_demo: true`, `ml_classifier: false`, rules-only mode, configured upload cap, and OCR availability.
- Scan JSON carries `public_demo: true`, `summary.public_demo: true`, `rules_only_fallback`, and a limitation explaining that no ML classifier was loaded. The UI displays a portfolio-demo banner.
- Files are parsed in memory; uploads and document contents are never stored. No database is provisioned. Session summaries and full reports are volatile, expire, and disappear after restart/spindown. With default Vercel and Render domains, cookies are cross-site; browser privacy settings can block session history even while the immediate upload response works. A custom same-site domain could improve cookie behavior but is outside this no-domain setup.
- Render Free may cold-start after inactivity (about a minute), restarts can happen, and included usage limits apply. Render states free web services are intended for hobby/testing and not production.
- PDF/DOCX/XLSX/PPTX parsing depends on the existing parser safeguards. OCR language data is not installed, so image OCR is unavailable and must be reported as such. Free RAM/CPU may still prevent some large or complex files from scanning; the 2 MiB upload cap and reduced parser-worker heap are safeguards, not a guarantee. If a live upload fails or the service runs out of memory, document that limitation and do not describe the workflow as verified.
- Do not upload sensitive documents. This service has no accounts, auth, durable evidence storage, or production security guarantees.

Render Free usage is currently documented as 750 instance hours per workspace/month; excess outbound bandwidth/build minutes may suspend services when no payment method is present, while adding a payment method can expose overage billing. Keep the account unconfigured for payment and do not enable billable services. See [Render's current Free plan rules](https://render.com/docs/free).

## Test and live verification

Local checks (from repository root):

```powershell
npm ci
npm test
npm run build:frontend
npm run eval
npm run eval:northwind
```

A local fixture evaluation requiring a running API can be run with `npm run eval:pdf-fixture` after starting the backend. Do not report a live evaluation result based on unit tests or local fixtures.

After deployment, verify and record:

1. Public frontend URL returns successfully and the demo banner is visible.
2. Render `/api/v1/health` returns HTTP 200.
3. Render `/api/v1/readiness` returns HTTP 200 and `storage: "session_ephemeral"`.
4. Render `/api/v1/capabilities` reports `public_demo: true`, `ml_classifier: false`, and `rules-only fallback`.
5. Upload an actual PDF through the public frontend, wait for any cold start, and confirm the UI shows a report with PDF parser status, actual source evidence, and rules-only mode. A live scan is not proof that the classifier works.
6. Check logs for parser/OOM failures without logging document content. Never expose environment values in screenshots or logs.

Current verification record: 2026-10-22; frontend `https://sentinel-ai-pearl-mu.vercel.app`; API `https://sentinel-ai-api-lduk.onrender.com`; health and readiness passed; capabilities matched the rules-only public demo; the actual fixture PDF upload returned a rendered report (parser completed, analysis partial, 22 heuristic findings, critical risk). A live upload has been verified, but per-payload detection accuracy, false-positive rate, cold-start reliability, and cross-site browser history persistence have not been measured. No database exists, so migration is not applicable. Repeat these checks after any deployment.
