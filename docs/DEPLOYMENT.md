# Deployment guide — Vercel + Render + PostgreSQL

This repository is a static frontend plus one long-running Node.js API. Vercel hosts only the static frontend; file uploads go directly from the browser to the Render service. They do not pass through a Vercel Function. The Node API enforces the existing 5 MiB upload cap and parser limits.

Render terminates public TLS before forwarding requests to the service. The service should use its HTTPS custom domain externally and the Render-provided `X-Forwarded-For` only for per-process rate-limit client identification; [Render documents its proxy/client-IP behavior](https://render.com/articles/how-render-handles-ddos-attacks).

Deployment has not been performed or live-verified. Do not treat the hosted service as ready until the checklist at the end passes.

## Required accounts and resources

Create or connect:

1. A Git provider repository containing this project, connected to both Vercel and Render.
2. A Vercel project for the static frontend.
3. A Render Node.js Web Service and a Render PostgreSQL database in the same region/workspace.
4. A custom domain under one registrable domain with two HTTPS hostnames, for example `sentinel.example.com` (Vercel) and `api.example.com` (Render). This keeps browser API calls same-site while remaining cross-origin. The default `vercel.app` and `onrender.com` domains are different sites; browsers may block the API's session cookie as a third-party cookie, breaking private history.
5. A Render persistent disk mounted at `/var/data`, sized at **at least 2 GiB** for the pinned classifier weights (about 740 MB), download staging, and English OCR data if enabled. Use a service plan with **at least 4 GiB RAM** for the first model-enabled trial and one concurrent scan. The full model startup/RSS profile has not been measured against a Render plan; this is a conservative starting target, not verified compatibility. Increase it if live metrics show memory pressure.

The project is already published on GitHub at `https://github.com/aka-KhanSameer/sentinel-ai` on branch `main`. Connect that existing repository to Vercel and Render; do not initialize another repository or push a generated starter commit. The latest verified local commit is `9223716` (`Initial Sentinel AI project`). Before deploying, confirm the intended commit is present in each provider's deployment source and that the repository remains private if that is your preference.

The `.gitignore` excludes `.env`, `models/`, and the generated frontend runtime config. Review `git status` before pushing; never add database URLs, model secrets, uploaded documents, or locally generated scan data.

The Render **Node** runtime downloads the pinned model revision if absent, verifies each downloaded file against upstream checksums, runs migrations before deploy, and starts the server. If download or migration fails, deployment fails. The classifier is required in this production configuration; readiness stays unavailable and scans fail with HTTP 503 if inference initialization fails. This prevents production from appearing healthy in rules-only fallback mode. Do not select Render's Docker runtime for this setup: the repository Dockerfile is intended for local Docker and does not run the production model-download or migration steps.

## Vercel frontend

In Vercel, import the repository and configure:

- Framework Preset: **Other**
- Root Directory: repository root (`.`)
- Install Command: `npm ci`
- Build Command: `npm run build:frontend`
- Output Directory: `frontend`
- Production environment variable: `PUBLIC_API_BASE_URL=https://api.example.com/api/v1` (replace with the actual Render custom domain)

The build writes `frontend/runtime-config.js`, exposing only the public API URL. Do not put secrets in this variable. Vercel serves static files; it does not host the Node API or run upload functions. After adding/updating the variable, trigger a new deployment.

Set the Vercel custom domain (for example `sentinel.example.com`) and complete the DNS instructions shown in its dashboard. HTTPS must show active before testing browser cookies.

## Render API and database

Create a Render PostgreSQL database, then create a Web Service from the same repository, in the **same region** as the database. Explicitly choose the **Node** runtime even though the repository also contains a Dockerfile. Set:

- Build Command: `npm ci`
- Start Command: `if [ ! -s "$SENTINEL_MODEL_DIR/onnx/model.onnx" ]; then npm run model:download; fi && npm start`
- Pre-Deploy Command: `npm run db:migrate`
- Health Check Path: `/api/v1/readiness`
- Persistent Disk: mount path `/var/data`, sized for model and OCR artifacts; do not mount over the application directory.
- Custom Domain: `api.example.com` (replace with your domain), then configure the DNS record Render provides and wait for HTTPS certificate activation.

Add these environment variables in Render (do not commit actual values):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | Leave unset; Render supplies it |
| `DATABASE_URL` | Render PostgreSQL **internal** connection URL, preferably linked through the Render dashboard |
| `DATABASE_SSL` | `disable` for the internal same-region URL. For external connections use `require`; never use `disable` with an external URL. |
| `REQUIRE_DATABASE` | `true` (prevents readiness and scans when PostgreSQL is absent or migrations are missing) |
| `CORS_ORIGINS` | Exact Vercel custom origin, e.g. `https://sentinel.example.com`; no trailing slash. Add the exact Vercel preview origin only if previews must call production. |
| `REQUIRE_LOCAL_CLASSIFIER` | `true` |
| `SENTINEL_MODEL_DIR` | `/var/data/sentinel-deberta-v3-prompt-injection-v2` |
| `SENTINEL_ML_THRESHOLD` | `0.5` |
| `SENTINEL_ML_MAX_CHUNKS` | `256` |
| `SENTINEL_ML_TIMEOUT_MS` | `120000` |
| `MAX_UPLOAD_BYTES` | `5242880` |
| `MAX_TEXT_BYTES` | `1048576` |
| `MAX_PROCESSING_MS` | `20000` |
| `MAX_CONCURRENT_SCANS` | `1` initially; raise only after load/memory testing |
| `RATE_LIMIT_WINDOW_MS` | `60000` |
| `RATE_LIMIT_REQUESTS` | `30` |
| `TRUST_PROXY` | `true` on Render so process-local rate limits key on the client address forwarded by Render; do not trust this header when bypassing Render's edge proxy |
| `SESSION_REPORT_TTL_MS` | `900000` |
| `MAX_SESSION_REPORTS` | `50` |
| `DATABASE_POOL_MAX` | `5` |
| `DATABASE_CONNECT_TIMEOUT_MS` | `3000` |
| `DATABASE_QUERY_TIMEOUT_MS` | `5000` |
| `TESSERACT_LANG_PATH` | `/var/data/tessdata` |
| `TESSERACT_LANG` | `eng` |

If OCR is desired, download and verify English tessdata into `/var/data/tessdata` using `npm run ocr:download` with `TESSERACT_LANG_PATH` set to that path. OCR is optional; the UI/API must report unavailable OCR explicitly if it is absent. This deployment guide does not configure extra languages.

The server persists only scan metadata in PostgreSQL, scoped to a random browser session hash and deleted after 30 days during scan inserts. It does not persist document contents or findings. Full reports are held in bounded server memory for 15 minutes, so they may disappear on restart or when a user reaches another instance. Do not increase instances or use this as multi-tenant storage without redesigning report storage and authentication. There are no accounts/user identities; session cookies are private-browser pseudonyms, not authentication.

## Database migration and connectivity

The Render start command runs `npm run db:migrate` before `npm start`. Migrations are checksum-verified and use a PostgreSQL advisory lock. For a manual migration from a trusted machine, set `DATABASE_URL` to the database's external URL and `DATABASE_SSL=require`, then run:

```sh
npm ci
npm run db:migrate
```

Do not paste or commit the connection URL. `GET https://api.example.com/api/v1/readiness` performs a bounded connection/migration-table check and returns only `ready`, storage mode, and a generic reason; it never returns the hostname, username, password, or URL. `GET /api/v1/health` is liveness only and does not prove database or classifier readiness.

## Local pre-deployment checks

```sh
npm ci
npm run build:frontend
npm test
npm run eval
npm run eval:northwind
npm run eval:pdf-fixture
```

Production build configuration can be checked without secrets:

```powershell
$env:PUBLIC_API_BASE_URL = 'https://api.example.com/api/v1'
npm run build:frontend
Get-Content frontend/runtime-config.js
```

The generated file must contain only the configured public API base. The root `vercel.json` already sets the install, build, and output-directory configuration.

## Live acceptance checklist

After both services deploy and custom-domain HTTPS is active:

1. Open `https://api.example.com/api/v1/health` and confirm HTTP 200.
2. Open `https://api.example.com/api/v1/readiness` and confirm HTTP 200, PostgreSQL storage, and classifier readiness.
3. Open `https://sentinel.example.com`; confirm the browser console has no CSP, CORS, or mixed-content errors and the UI reports local ML configured.
4. Upload a known benign PDF and a known prompt-injection test PDF through the live UI. Confirm each produces a report with PDF source locations, local classifier mode, and a nonzero classifier coverage ratio.
5. Refresh the page and confirm only the same browser session sees its metadata history. Confirm the full evidence report's documented in-memory expiry behavior.
6. Check Render logs for successful migration/model verification and absence of document text. Never log or share database URLs.

## Current blockers and limits

- Vercel and Render dashboard access is authenticated. The private GitHub repository is connected and visible to Render. No Sentinel Vercel project, Render database/service, or custom domain is provisioned; production connectivity, database migration, HTTPS, and live upload have not been verified.
- The classifier weights are excluded from Git. The documented Render start step fetches the pinned, checksum-verified artifact into a persistent disk; outbound access to Hugging Face and sufficient disk/memory must be confirmed in the selected plan.
- The model has run locally, but no peak memory/concurrency benchmark on Render is available. The Render dashboard currently lists $85/month for a 2 CPU / 4 GB RAM service; a 2 GB persistent disk is $0.50/month. This is the documented conservative first-trial size, not verified runtime compatibility. Do not scale beyond one concurrent scan until measured.
- The Render dashboard's free web-service option has 512 MB RAM and does not support persistent disks. It cannot meet this model-enabled deployment's documented 4 GB starting target or retain weights across deploys. Rules-only mode must not be used as a substitute. The user declined paid resources, so no Render service or database was created.
- The paid configuration currently displayed in Render totals about $91.80/month before tax/other usage: $85 for the 4 GB service, $0.50 for a 2 GB disk, and $6.30 for a 256 MB PostgreSQL instance with 1 GB storage. No resources have been created or charges initiated.
- Vercel shows the existing Hobby workspace, but no Sentinel project has been created. The static frontend and `PUBLIC_API_BASE_URL` are not deployed/configured. The user chose default provider hostnames for now; Vercel and Render hostnames are cross-site, so browser session cookies/history may fail when third-party cookies are blocked. No custom domain or DNS change was performed.
- The app is a prototype without user authentication, account-level access controls, durable full reports, or multi-instance affinity. A random browser session cookie is not a substitute for authentication. Limit access to a demo audience; do not upload sensitive documents or treat it as a production security control.
- Known detector limitations remain: the Northwind X-12 CJK attack was missed; the 40-item synthetic evaluation had one false positive and one false negative. These results do not establish real-world detection accuracy.
