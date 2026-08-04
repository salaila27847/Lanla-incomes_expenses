# Deploy: Vercel (free)

This repo is a monorepo with three independently deployable services (see `CLAUDE.md`). Vercel can't deploy a JS + Python + static monorepo as a single project — each service becomes its own Vercel project pointed at the same GitHub repo, with a different **Root Directory**.

Do these in order — each step's env vars need the previous step's deployed URL.

Before starting: finish `SETUP.md` (the Google Sheet + service account) first, and decide whether you'll use real `TYPHOON_API_KEY` / `SAVINGS_PROMPTPAY_ID` or leave those in mock/disabled mode for now.

## 1. Backend (Python/FastAPI)

1. On [vercel.com](https://vercel.com), sign up free, then **Add New → Project → Import** this GitHub repo.
2. Under **Root Directory**, select `backend`.
3. Framework preset: Other (Vercel auto-detects `backend/vercel.json` and `backend/api/index.py`).
4. Add these Environment Variables (values from `backend/.env.example`):
   - `TYPHOON_API_KEY`, `TYPHOON_BASE_URL`, `TYPHOON_OCR_MODEL`
   - `OCR_MOCK_MODE` (`true` if you don't have a Typhoon key yet)
   - `MATCH_CONFIDENCE_THRESHOLD`
   - `SAVINGS_PROMPTPAY_ID` (leave blank if you don't want QR working yet)
   - `CONTROLLER_SHARED_SECRET`
5. Deploy. Copy the resulting URL (e.g. `https://your-backend.vercel.app`) — you'll need it in step 2.

## 2. Controller (Node.js/Express)

1. **Add New → Project → Import** the same repo again, this time **Root Directory** = `controller`.
2. Environment Variables:
   - `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` — the *contents* of the service-account key file, pasted as one value (Vercel's env var box accepts multi-line values fine, so you can paste the raw JSON as-is). This is the Vercel-friendly alternative to `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`, which only works for local dev (see `controller/src/sheets/client.ts`).
   - `SHEETS_SPREADSHEET_ID`
   - `SHEETS_MOCK_MODE=false`
   - `PYTHON_BACKEND_URL` = the backend URL from step 1
3. Deploy. Copy this URL too — you'll need it in step 3.

## 3. Frontend (React PWA)

1. **Add New → Project → Import** the repo once more, **Root Directory** = `frontend`.
2. Framework preset: Vite (auto-detected).
3. Environment Variable: `VITE_API_BASE_URL` = the controller URL from step 2.
   - This has to be set *before* deploying — Vite bakes `VITE_*` vars into the build at build time, not read at runtime, so changing it later means redeploying.
4. Deploy.

## Verify it's working

Open the frontend's Vercel URL, scan a receipt, review and confirm it, then check the real Google Sheet — new rows should appear in `MasterItems`/`PriceHistory`. If nothing shows up, check the controller project's Vercel function logs first (most likely cause: a typo in `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` or the Sheet not shared with the service account's email).
