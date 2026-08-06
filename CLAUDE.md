# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Smart Expense & Price Tracker: a receipt-OCR-driven expense/budget/price-history PWA. Full product spec (features, data model, diagrams) is in `SPEC.md` — read it before making feature-level changes. This file covers how the code is organized and how to run it.

## Architecture

Monorepo with three independently deployable services, no shared build tooling between them:

- **`/frontend`** — React + TypeScript PWA (Vite, Tailwind CSS, `vite-plugin-pwa`). The only user-facing surface: scan receipts, review/re-categorize line items, look up price history, manage budget, view the annual dashboard, and trigger the savings-protection QR flow. Pages live in `frontend/src/pages/`, one per top-level nav item (`ReceiptReview`, `PriceHistory`, `Budget`, `Dashboard`, `SavingsQR`). Every page is a single mobile column except `Dashboard`, whose table is twelve pay-cycle columns wide — `App.tsx` widens the container for that route alone.
- **`/controller`** — Node.js + Express + TypeScript. Owns Google Sheets (the database) via the Sheets API (`googleapis`, service-account auth in `controller/src/sheets/client.ts`), and proxies OCR/matching/QR work to `/backend`. Routes in `controller/src/routes/` map 1:1 to frontend features (`receipt`, `prices`, `budget`, `dashboard`, `income`, `qr`).
- **`/backend`** — Python + FastAPI, deployed as Vercel serverless functions. Stateless compute only: line-item OCR, fuzzy master-item matching, PromptPay QR generation. Never touches Google Sheets directly — everything goes through `/controller`. Route logic lives in `backend/app/routers/`; `backend/api/index.py` is the single Vercel serverless entry point (all routers mounted on one FastAPI app, avoids the per-file routing that Vercel's rewrite config can't resolve), and `backend/main.py` mounts the same routers for local dev.

**Data flow:** PWA → `/controller` (auth to Sheets via service account) → `/backend` for OCR/matching/QR → back to `/controller` → write result to Sheets → back to PWA. This replaces the Apps-Script-based controller in `SPEC.md`'s original diagram with a Node.js service; Google Sheets itself is still the database. See the "Implementation notes" at the top of `SPEC.md` for why.

**Current state:** all four spec features work end-to-end:
- `/backend`'s OCR (`app/routers/ocr.py`) and fuzzy matching (`app/routers/match.py`) are real — matching via `rapidfuzz`. OCR is two Typhoon calls, not one: `typhoon-ocr` is only served through a dedicated `POST {base}/ocr` multipart endpoint (not `/chat/completions`, and it takes no custom prompt — it just returns the document's raw OCR text), so a second call to a regular chat model (`TYPHOON_TEXT_MODEL`, default `typhoon-v2.5-30b-a3b-instruct`) turns that raw text into our `{store, purchased_at, items}` schema. Model IDs vary per account and can't be verified from the docs — on a "Model not found" the logs print every model the key can actually reach. OCR defaults to `OCR_MOCK_MODE=true` (returns a canned fixture from `app/fixtures/sample_receipt.py`) since no `TYPHOON_API_KEY` or real receipt photos exist yet. `/backend`'s `/qr` builds a PromptPay EMVCo payload (`app/promptpay.py`, verified against the reference implementation's own test vectors) and renders it with `qrcode` — no mock mode, since it's pure computation with no external service, but it needs `SAVINGS_PROMPTPAY_ID` set in `.env` (the savings account's PromptPay ID) or it 400s.
- `/controller`'s Sheets client (`src/sheets/client.ts`) covers all six tabs (`MasterItems`, `PriceHistory`, `MustPay`, `Cycles`, `Income`, `Settings`); its `/receipt/scan`, `/receipt/confirm`, `/budget`, `/prices`, `/dashboard`, `/income`, and `/qr` (a thin proxy to the backend) routes are real. Defaults to `SHEETS_MOCK_MODE=true` (in-memory lists stand in for the sheet tabs) since no Google Sheet or service account exists yet — see `SETUP.md` for that one-time manual setup.
- `/frontend`'s `ReceiptReview` page (route `/scan`) has two modes — scan a receipt or type lines in by hand — and either way each line is reviewed with a quantity stepper, a unit price, and a master-item picker before saving. `Budget` shows the current pay cycle's spend against the food/goods caps (computed from `PriceHistory`) and a must-pay checklist (add via a name+amount form with autocomplete over previously-used names, mark paid with a tap — manual, not tied to receipt scanning). `Dashboard` is the annual view: twelve pay-cycle columns, rows for income by source / bills by name / food+goods from receipts, and summary rows for totals, net, and both account balances. It also owns the payday calendar and the budget settings. `PriceHistory` searches master item names (substring match) and shows results grouped by store, newest first. `SavingsQR` posts an amount and renders the returned QR image.

## Unit price vs line total

`PriceHistory.Price` is **per unit**; `Quantity` multiplies it. Which one to use is not a style choice:

- **Anything summing money uses `price * quantity`** — `budget.ts` and `dashboard.ts`. These are the only two places, and both carry a comment saying so.
- **Price comparison uses `price` alone** — `prices.ts`. A 3-pack's total isn't comparable to a single unit bought elsewhere, and comparing them is what would make the price history useless.

OCR is asked for `quantity` and `line_total` (both printed on the receipt) and `_normalise_items` in `ocr.py` does the division. Asking the model for a per-unit price instead puts arithmetic in the least reliable part of the pipeline, and a plausible wrong price is invisible — it just becomes that product's recorded price.

A blank `Quantity` reads as 1, so rows written before the column existed still total correctly.

## Master item matching

`/match` returns a ranked `candidates` list and two thresholds gate it: `MATCH_CONFIDENCE_THRESHOLD` (60) is the floor for suggesting anything, `MATCH_AUTO_APPLY_THRESHOLD` (90) is where the top candidate gets pre-selected. In between, candidates are shown but nothing is chosen.

The gap exists because receipts frequently don't print the brand. Measured `fuzz.WRatio` scores: `นมสด250ml` scores **64 against both** `นมสด โฟร์โมสต์ 250ml` and `นมสด ดัชมิลล์ 250ml` — identically, because the deciding information isn't in the text. No scorer breaks that tie. Meanwhile pure spacing noise (`นมสดUHT250ml` vs `นมสด UHT 250ml`) scores 92 and shouldn't cost a tap. Tuning the threshold cannot fix the first case; only the picker can.

Every line gets a picker, including auto-matched ones. An earlier version printed a confident match as unchangeable text, which is how two brands quietly shared one price history.

## Pay cycles

The user's month starts when their salary lands, not on the 1st. `controller/src/cycles.ts` holds the whole model as pure functions; `controller/src/cycleService.ts` is the only thing that pairs it with the `Cycles` tab, so `cycles.ts` stays I/O-free and unit-testable.

Three rules are load-bearing, and changing any of them silently moves money between columns:

- **A cycle is `[payday, next payday − 1 day]`.** Paydays are entered by the user (they shift with weekends and holidays — 23rd to 28th in practice), not derived from a fixed day-of-month. Cycles therefore partition the timeline: every date is in exactly one.
- **A cycle is named for the month whose 15th falls inside it** — i.e. `day(payday) <= 15 ? that month : the next one`. Since cycles are ~1 month long and partition the timeline, exactly one cycle contains any given 15th, so the naming is total and collision-free. A payday on 26 Dec funds January. `PUT /dashboard/cycles/:key` rejects a payday outside that window rather than letting two cycles claim one key.
- **Undated cycles borrow the day-of-month of the nearest dated one**, clamped to the target month's length. That keeps the dashboard renderable before the calendar is filled in.

`MustPay.Month` stores a cycle key, not a calendar month. The two have the same `YYYY-MM` shape, so rows written before cycles existed still read correctly — only newly-written rows change meaning.

The food/goods caps are **per cycle**, not per day. An earlier version compared a single day's spend against 5,000 THB, which nothing at this budget could reach; the user's own spreadsheet reads `เป้าหมาย 5,000/เดือน` against actuals of 4,000–6,000 a month.

The dashboard's two balances come from different places on purpose: the **spending** account is derived (`opening_balance` + income − expenses, run forward over *every* cycle on record, not just the displayed year), while the **savings** account is entered by hand per cycle, because money sometimes leaves it directly — which is what the SavingsQR transfer-back flow exists to reverse.

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
npm test           # vitest run
```

Backend (`/backend`):
```
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt   # requirements.txt + pytest
uvicorn main:app --reload   # local dev, all routes under one server on :8000
pytest                      # test suite
```

Each service has its own `.env.example` — copy to `.env` and fill in before running. For `/controller`, see `SETUP.md` for the one-time Google Sheet + service-account setup needed before turning off `SHEETS_MOCK_MODE`. To host all three on Vercel's free tier instead of running locally, see `DEPLOY.md`.

## Tests

`/backend` (pytest) and `/controller` (vitest + supertest) have suites; `/frontend` does not yet, and there is no linter or CI in any of the three.

Both suites run fully offline — the backend fakes Typhoon with `httpx.MockTransport` (see the `typhoon` fixture in `backend/tests/conftest.py`), and the controller runs the Sheets client in `SHEETS_MOCK_MODE` and stubs `fetch` for backend calls. No API keys or network access needed.

Three things worth knowing before adding tests:

- **Config is captured at import time.** `app/config.py` reads `os.environ` once, and the routers import those values *by value*, so changing the environment mid-test does nothing — patch the attribute on the router module (`monkeypatch.setattr(ocr_router, "OCR_MOCK_MODE", False)`) or reload `app.config`. The controller's Sheets client is the same: `vi.resetModules()` then re-import. Its in-memory tabs are module-level too, so a re-import is also how a test gets a clean database.
- **Prefer anchors the implementation can't move.** `test_promptpay.py` checks a payload published by the reference implementation and the universal CRC-16/CCITT-FALSE check value (`"123456789"` → `0x29B1`), rather than whatever our own builder currently emits. `cycles.test.ts` does the same with `SPREADSHEET_COLUMNS`: the twelve payday→month pairings transcribed from the user's own spreadsheet, written by hand long before this code existed.
- **Time is faked, not observed.** Anything cycle- or date-filtered (`budget`, `dashboard`) pins "today" with `vi.setSystemTime`, or the suite starts failing on a date that isn't the one it was written on.
