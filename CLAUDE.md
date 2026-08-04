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

**Current state:** `/backend`'s OCR (`app/routers/ocr.py`) and fuzzy matching (`app/routers/match.py`) are implemented for real — OCR via Typhoon OCR's OpenAI-compatible API, matching via `rapidfuzz`. OCR defaults to `OCR_MOCK_MODE=true` (returns a canned fixture from `app/fixtures/sample_receipt.py`) since no `TYPHOON_API_KEY` or real receipt photos exist yet; flip it off once you have a key. QR generation, the `/controller`'s Google Sheets read/write, and the full upload → OCR → match → review → Sheets-write pipeline are still `501 Not Implemented` stubs with `TODO` comments.

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

Each service has its own `.env.example` — copy to `.env` and fill in before running.

There is no test suite, linter, or CI configured yet in any of the three services.
