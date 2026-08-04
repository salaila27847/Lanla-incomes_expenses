# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Smart Expense & Price Tracker: a receipt-OCR-driven expense/budget/price-history PWA. Full product spec (features, data model, diagrams) is in `SPEC.md` — read it before making feature-level changes. This file covers how the code is organized and how to run it.

## Architecture

Monorepo with three independently deployable services, no shared build tooling between them:

- **`/frontend`** — React + TypeScript PWA (Vite, Tailwind CSS, `vite-plugin-pwa`). The only user-facing surface: scan receipts, review/re-categorize line items, look up price history, manage budget, and trigger the savings-protection QR flow. Pages live in `frontend/src/pages/`, one per top-level nav item (`ReceiptReview`, `PriceHistory`, `Budget`, `SavingsQR`).
- **`/controller`** — Node.js + Express + TypeScript. Owns Google Sheets (the database) via the Sheets API (`googleapis`, service-account auth in `controller/src/sheets/client.ts`), and proxies OCR/matching/QR work to `/backend`. Routes in `controller/src/routes/` map 1:1 to frontend features (`receipt`, `prices`, `budget`, `qr`).
- **`/backend`** — Python + FastAPI, deployed as Vercel serverless functions. Stateless compute only: line-item OCR, fuzzy master-item matching, PromptPay QR generation. Never touches Google Sheets directly — everything goes through `/controller`. Route logic lives in `backend/app/routers/`; `backend/api/*.py` are the individual Vercel entry points, `backend/main.py` mounts the same routers together for local dev.

**Data flow:** PWA → `/controller` (auth to Sheets via service account) → `/backend` for OCR/matching/QR → back to `/controller` → write result to Sheets → back to PWA. This replaces the Apps-Script-based controller in `SPEC.md`'s original diagram with a Node.js service; Google Sheets itself is still the database. See the "Implementation notes" at the top of `SPEC.md` for why.

**Current state:** all four spec features work end-to-end:
- `/backend`'s OCR (`app/routers/ocr.py`) and fuzzy matching (`app/routers/match.py`) are real — OCR via Typhoon OCR's OpenAI-compatible API, matching via `rapidfuzz`. OCR defaults to `OCR_MOCK_MODE=true` (returns a canned fixture from `app/fixtures/sample_receipt.py`) since no `TYPHOON_API_KEY` or real receipt photos exist yet. `/backend`'s `/qr` builds a PromptPay EMVCo payload (`app/promptpay.py`, verified against the reference implementation's own test vectors) and renders it with `qrcode` — no mock mode, since it's pure computation with no external service, but it needs `SAVINGS_PROMPTPAY_ID` set in `.env` (the savings account's PromptPay ID) or it 400s.
- `/controller`'s Sheets client (`src/sheets/client.ts`) covers all three tabs (`MasterItems`, `PriceHistory`, `MustPay`); its `/receipt/scan`, `/receipt/confirm`, `/budget`, `/prices`, and `/qr` (a thin proxy to the backend) routes are real. Defaults to `SHEETS_MOCK_MODE=true` (in-memory lists stand in for the sheet tabs) since no Google Sheet or service account exists yet — see `SETUP.md` for that one-time manual setup.
- `/frontend`'s `ReceiptReview` page scans, reviews/re-categorizes, names unmatched items, and saves. `Budget` shows today's spend against the 5,000/5,000 THB caps (computed from `PriceHistory`) and a must-pay checklist (add via a name+amount form with autocomplete over previously-used names, mark paid with a tap — manual, not tied to receipt scanning). `PriceHistory` searches master item names (substring match) and shows results grouped by store, newest first. `SavingsQR` posts an amount and renders the returned QR image.

Nothing is stubbed anymore at the route level; remaining work is real accounts/credentials (`SETUP.md`, `TYPHOON_API_KEY`, `SAVINGS_PROMPTPAY_ID`) and no test suite/CI yet.

## Commands

Frontend (`/frontend`):
```
npm install
npm run dev      # Vite dev server on :5173
npm run build    # tsc -b && vite build
```

Controller (`/controller`):
```
npm install
npm run dev       # tsx watch, Express on :3001 (PORT env var)
npm run build      # tsc -> dist/
npm start          # run the built dist/index.js
```

Backend (`/backend`):
```
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload   # local dev, all routes under one server on :8000
```

Each service has its own `.env.example` — copy to `.env` and fill in before running. For `/controller`, see `SETUP.md` for the one-time Google Sheet + service-account setup needed before turning off `SHEETS_MOCK_MODE`.

There is no test suite, linter, or CI configured yet in any of the three services.
