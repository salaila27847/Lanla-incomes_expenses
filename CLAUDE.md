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
- `/controller`'s Sheets client (`src/sheets/client.ts`) covers all nine tabs (`MasterItems`, `PriceHistory`, `PendingSavings`, `MustPay`, `RecurringBills`, `Cycles`, `SlipPayees`, `Income`, `Settings`); its `/receipt/scan`, `/receipt/scan-slip` and `/receipt/confirm` (see "Transfer-slip scanning" below), `/budget` (plus `/budget/recurring` — see "Recurring bills" below), `/prices`, `/dashboard`, `/income`, and `/qr` (a thin proxy to the backend, plus `/qr/pending` for the savings-transfer queue — see "Savings-sourced purchases" below) routes are real. Defaults to `SHEETS_MOCK_MODE=true` (in-memory lists stand in for the sheet tabs) since no Google Sheet or service account exists yet — see `SETUP.md` for that one-time manual setup.
- `/frontend`'s `ReceiptReview` page (route `/scan`) has three modes — scan an itemised receipt, scan a transfer slip (see "Transfer-slip scanning" below), or type lines in by hand — and either way each line is reviewed with a quantity stepper, a unit price, a master-item picker, and a payment-source toggle (บัญชีหลัก / เงินออม KTB) before saving. `Budget` shows the current pay cycle's spend and remaining balance against the food/goods caps (computed from `PriceHistory`), a must-pay checklist (add via a name+amount form with autocomplete over previously-used names, mark paid with a tap — manual, not tied to receipt scanning, plus any rows a recurring bill generated automatically, marked with 🔁), and a recurring-bills manager (add one with an optional instalment count and card group, stop one early). `Dashboard` is the annual view: twelve pay-cycle columns, rows for income by source / bills by name / food+goods from receipts, and summary rows for totals, net, and both account balances. It also owns the payday calendar and the budget settings. `PriceHistory` searches master item names (substring match) and shows results grouped by store, newest first. `SavingsQR` posts an amount and renders the returned QR image, and lists any receipt lines paid from savings that are still waiting on their transfer-back confirmation.

## Unit price, quantity, discount

`PriceHistory.Price` is **per unit and before any discount**; `Quantity` multiplies it; `Discount` comes off the line. Which figure to use where is not a style choice:

- **Anything summing money uses `lineTotal(row)`** (`price * quantity - discount`, exported from `sheets/client.ts`) — `budget.ts` and `dashboard.ts`. These are the only two places.
- **Price comparison uses `price` alone** — `prices.ts`. A 3-pack's total isn't comparable to a single unit bought elsewhere, and a promo that won't be there next time shouldn't become what a product costs. `netPrice` rides along for when the discount is the interesting part.

OCR is asked for `quantity` and `line_total` (both printed on the receipt) and `_normalise_items` in `ocr.py` does the division. Asking the model for a per-unit price instead puts arithmetic in the least reliable part of the pipeline, and a plausible wrong price is invisible — it just becomes that product's recorded price. Discounts come back as positive amounts; receipts print them negative and `_positive_amount` strips the sign, because a negative discount would *add* to the bill.

A **bill-level discount** — one that belongs to no single product — is its own row: `price` 0 with the amount in `discount`, so it totals negative with no negative price anywhere. `isDiscountOnly` identifies those and `/prices` skips them; a genuinely free item (price 0, no discount) is still a real data point and stays.

Blank `Quantity` reads as 1 and blank `Discount` as 0, so rows written before those columns existed still total correctly.

## Master item matching

`/match` returns a ranked `candidates` list and two thresholds gate it: `MATCH_CONFIDENCE_THRESHOLD` (60) is the floor for suggesting anything, `MATCH_AUTO_APPLY_THRESHOLD` (90) is where the top candidate gets pre-selected. In between, candidates are shown but nothing is chosen.

The gap exists because receipts frequently don't print the brand. Measured `fuzz.WRatio` scores: `นมสด250ml` scores **64 against both** `นมสด โฟร์โมสต์ 250ml` and `นมสด ดัชมิลล์ 250ml` — identically, because the deciding information isn't in the text. No scorer breaks that tie. Meanwhile pure spacing noise (`นมสดUHT250ml` vs `นมสด UHT 250ml`) scores 92 and shouldn't cost a tap. Tuning the threshold cannot fix the first case; only the picker can.

Every line gets a picker, including auto-matched ones. An earlier version printed a confident match as unchangeable text, which is how two brands quietly shared one price history.

## Amount inputs

A controlled numeric input holds the **raw string**, never a number. Coercing on every keystroke makes half-typed values unrepresentable: `Number("12.")` is `12`, so pressing the decimal point erases it and no price with satang can be entered at all — which is exactly what happened to the price box on `ReceiptReview`. Clearing the box has the same shape: `Number("")` is `0`, so the field springs back to "0".

Parse with `parseAmount` from `frontend/src/money.ts`, never `Number(x) || 0`. The `|| 0` is the other half of the bug: it turns a typo into a silent zero, and lets `-5` and `1e3` through into a total.

`parseAmount` returns `null` for an empty box and `0` for a genuine zero — collapsing those is how an empty field would save as a free item.

## Pay cycles

The user's month starts when their salary lands, not on the 1st. `controller/src/cycles.ts` holds the whole model as pure functions; `controller/src/cycleService.ts` is the only thing that pairs it with the `Cycles` tab, so `cycles.ts` stays I/O-free and unit-testable.

Three rules are load-bearing, and changing any of them silently moves money between columns:

- **A cycle is `[payday, next payday − 1 day]`.** Paydays are entered by the user (they shift with weekends and holidays — 23rd to 28th in practice), not derived from a fixed day-of-month. Cycles therefore partition the timeline: every date is in exactly one.
- **A cycle is named for the month whose 15th falls inside it** — i.e. `day(payday) <= 15 ? that month : the next one`. Since cycles are ~1 month long and partition the timeline, exactly one cycle contains any given 15th, so the naming is total and collision-free. A payday on 26 Dec funds January. `PUT /dashboard/cycles/:key` rejects a payday outside that window rather than letting two cycles claim one key.
- **Undated cycles borrow the day-of-month of the nearest dated one**, clamped to the target month's length. That keeps the dashboard renderable before the calendar is filled in.

`MustPay.Month` stores a cycle key, not a calendar month. The two have the same `YYYY-MM` shape, so rows written before cycles existed still read correctly — only newly-written rows change meaning.

The food/goods caps are **per cycle**, not per day. An earlier version compared a single day's spend against 5,000 THB, which nothing at this budget could reach; the user's own spreadsheet reads `เป้าหมาย 5,000/เดือน` against actuals of 4,000–6,000 a month.

The dashboard's two balances come from different places on purpose: the **spending** account is derived (`opening_balance` + income − expenses, run forward over *every* cycle on record, not just the displayed year), while the **savings** account is entered by hand per cycle, because money sometimes leaves it directly — which is what the SavingsQR transfer-back flow exists to reverse. A savings-tagged `Income` entry is the one exception that writes to `Cycles.SavingsBalance` automatically rather than waiting for a hand-typed correction — see "Savings deposits" below for why that's safe.

## Savings deposits

Income is a normal deposit into the spending account by default (`IncomeEntry.destinationAccount`, blank/`"spending"` for every entry written before this field existed). Tagging one `"savings"` instead — a bonus, a windfall, a mid-month top-up — rolls it straight into that entry's cycle on `Cycles.SavingsBalance`, adding to whatever's already recorded there (`POST /income` resolves the cycle via `cycleContaining(date)` and adds the amount) rather than making the user go retype the running total by hand.

This looks like it contradicts the "entered by hand" rule for savings above, but it doesn't: that rule exists because money **leaving** the account can happen by a route the app never sees, so it can't be safely derived. Money **arriving** via an `Income` entry has no such blind spot — the user just told the app about it — so folding it in immediately isn't fabricating a number, it's the one case where the app actually knows the delta. The manually-entered figure is still the one that matters when it's next corrected; this only nudges it forward between corrections.

The Dashboard's `+ รายรับ` form carries the spending/savings switch (default spending, matching the field's default). `SavingsQR`'s "รายการเคลื่อนไหวบัญชีออมรอบนี้" section shows this cycle's savings-tagged `Income` entries as the "in" half — see "Savings-sourced purchases" below for the "out" half, and why paying with savings has no shortcut into `ReceiptReview` from this page: that would duplicate the receipt tab, which already covers it.

## Savings-sourced purchases

`Cycles.SavingsBalance` is a snapshot, not a ledger — it says what the account held at cycle-end, not which purchases came out of it. `ReceiptReview` lets each line be tagged `paid_from: "savings"` (default `"spending"`, so every caller that predates the field is unaffected) for exactly that gap: a line item paid straight out of savings.

A savings-tagged line is **not** written to `PriceHistory` on `/receipt/confirm` — it goes to `PendingSavingsItem` (`sheets/client.ts`, tab `PendingSavings`) instead, and stays there until it's settled on the `SavingsQR` page's "รายการรอโอนคืน" section. Settling always writes the pending item's own stored `date` (never the settlement date — a purchase near the end of a cycle but settled days later must stay in the cycle it was actually bought in, same invariant the pay-cycle partition rules above depend on) into a real `PriceHistory` row, the same shape and meaning regardless of which of the two paths below was chosen — price history doesn't care which account ends up paying. `DELETE /qr/pending/:id` is the third option: backing out of a mistaken "pay with savings" tap without writing anything.

The two settlement paths differ in what they do to the savings account, not in what they do to price history:

- **"โอนคืนบัญชีใช้จ่าย"** (`POST /qr/pending/:id/confirm`) — the spending account pays the savings account back; the `SavingsQR` page's QR generator is what sends that transfer. This is the *temporary front* case: savings covered the purchase at checkout because that was more convenient, and the spending account settles up. Net effect on `SavingsBalance` is zero (it left, then came back), so nothing is logged for the movement list beyond the `PriceHistory` row every settlement writes.
- **"หักจากบัญชีเงินออม"** (`POST /qr/pending/:id/deduct`) — the savings account keeps the cost, permanently: a big item actually saved up for, not a temporary front. This also appends a `SavingsWithdrawal` (`sheets/client.ts`, tab `SavingsWithdrawals`) and lowers that cycle's `Cycles.SavingsBalance` by the amount immediately — the same reasoning as a savings-tagged `Income` deposit raising it: the app was just told about a real, known change, so applying it right away isn't fabricating a number.

This model means `MasterItems`/`PriceHistory`/budget/dashboard totals never see a savings-sourced line until it's settled one way or the other; a pending item sitting unsettled is invisible to price search and the food/goods caps by design, not by omission.

Both paths are additive, not a replacement for the manually-entered `SavingsBalance`: money can still leave the savings account by a route the app never sees (a transfer made outside this flow, cash), so the manual per-cycle balance stays the source of truth for reconciliation — the movement list only accounts for what the app was told about.

## Recurring bills

Per SPEC.md's own implementation notes, `MustPay` originally had **no** automatic monthly regeneration on purpose — every bill was re-typed each cycle (autocomplete over past names only sped that up). `RecurringBill` (`sheets/client.ts`, tab `RecurringBills`) is the deliberate walk-back of that: a template, separate from any single cycle's `MustPay` row, because a cycle's row still needs to be editable and markable-paid independently of the template that produced it.

`GET /budget` generates the current cycle's rows from every active `RecurringBill` the first time that cycle is asked for. `RecurringGroupKey` (`cardGroup ?? id`) is what tells "already generated" apart from "the user happened to type the same name by hand" — a `MustPay` row carrying it came from a `RecurringBill`, not a hand-typed one.

Two things a fixed cost can do that a plain repeat can't:

- **End on its own.** `installmentsRemaining` is `null` for something with no natural end (rent, utilities) — it recurs forever. A number counts down by one every time its bill gets billed, and the bill goes `active: false` at zero, the same way a real instalment plan finishes without needing to be remembered and cancelled.
- **Bill together.** Several instalments charged to the same card collapse into **one** `MustPay` row per cycle — `cardGroup` groups them, the row is named for the card (not whichever instalment happens to be first) and its amount is the group's sum, because what actually gets paid is one card statement, not one transfer per product on it.

Generation has to tolerate a group's row already existing for the cycle, because it routinely does: the Budget page calls `GET /budget` again after every `POST /budget/recurring`, so adding a second or third instalment to a card group is normal *after* its row from the first already generated. An earlier version skipped a group entirely once any row existed for it, which left the row's amount stuck at whatever the group summed to on that first call — every instalment added afterward silently never made it into what the row said was owed. Generation now always recomputes the group's sum from every active bill and rewrites the row's amount (`updateMustPayAmount`) when it's changed. That reuses the same group-level check for a different purpose than counting down instalments, so decrementing needed its own per-bill guard: `RecurringBill.lastBilledCycle` (blank = never billed) records the cycle a bill's instalment was last counted down for, and generation only decrements a bill whose `lastBilledCycle` isn't already the current cycle — otherwise an older bill in the group would lose an extra instalment every time a new one joins it mid-cycle.

`POST /budget/recurring/:id/stop` deactivates a bill without touching rows it already generated — paying something off early doesn't rewrite history. `DELETE /budget/recurring/:id` is the separate, harder undo for a bill that shouldn't have existed at all.

## Transfer-slip scanning

A bank transfer/payment slip isn't an itemised receipt — it carries no product lines, only who was paid, when, and the total that moved — so it gets its own path end to end rather than being forced through the receipt schema. `POST /ocr/slip` (`backend/app/routers/ocr.py`) shares stage 1 (raw OCR text) with the receipt flow but structures stage 2 with its own prompt into `{payee, purchased_at, amount, transaction_id}`, no `items`. `POST /receipt/scan-slip` (`controller/src/routes/receipt.ts`) proxies that and adds `suggested_store`, looked up from `SlipPayees` (`sheets/client.ts`) — a slip's registered payee name (e.g. `ร้านถุงเงิน (แซ่บเล้ง แอนด์ หม่าล่านายเบิร์ด)`) is rarely how the user refers to that store elsewhere, so the mapping is remembered rather than re-typed.

`ReceiptReview`'s `slip` mode drops straight into the same manual line-entry UI as `manual` mode, pre-filled with the slip's date and `suggested_store` (or the raw payee text, if this payee has never been mapped before), and shows a live "คงเหลือที่ยังไม่ลงรายการ" (amount not yet itemised) = slip amount − entered total. Saving is **hard-blocked** until that reaches exactly zero — not just a warning — because a tip or delivery fee is part of the same real-world transfer and has to be itemised too, not left as an unexplained gap. `POST /receipt/confirm` enforces the same check server-side when its optional `slip` field is present (tolerating only float-level noise, a fraction of a satang), rejecting the whole batch rather than writing a partial one, and only remembers the payee → store mapping *after* a successful write — a rejected reconciliation must never teach the mapping a store name the user didn't actually confirm.

Nothing is stubbed anymore at the route level; remaining work is real accounts/credentials (`SETUP.md`, `TYPHOON_API_KEY`, `SAVINGS_PROMPTPAY_ID`).

## Commands

Frontend (`/frontend`):
```
npm install
npm run dev      # Vite dev server on :5173
npm run build    # tsc -b && vite build
npm test         # vitest run
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

`/backend` (pytest), `/controller` (vitest + supertest) and `/frontend` (vitest) have suites; there is no linter in any of the three. The frontend's covers pure helpers only — there is no DOM or component testing set up.

All three run fully offline — the backend fakes Typhoon with `httpx.MockTransport` (see the `typhoon` fixture in `backend/tests/conftest.py`), and the controller runs the Sheets client in `SHEETS_MOCK_MODE` and stubs `fetch` for backend calls. No API keys or network access needed.

`.github/workflows/test.yml` runs all three on every pull request and on `main` after a merge. Because the suites need no credentials, CI is configured with no secrets at all. It is separate from Vercel's three checks, which only prove each service *builds* — a wrong sum type-checks, builds and deploys perfectly.

Three things worth knowing before adding tests:

- **Config is captured at import time.** `app/config.py` reads `os.environ` once, and the routers import those values *by value*, so changing the environment mid-test does nothing — patch the attribute on the router module (`monkeypatch.setattr(ocr_router, "OCR_MOCK_MODE", False)`) or reload `app.config`. The controller's Sheets client is the same: `vi.resetModules()` then re-import. Its in-memory tabs are module-level too, so a re-import is also how a test gets a clean database.
- **Prefer anchors the implementation can't move.** `test_promptpay.py` checks a payload published by the reference implementation and the universal CRC-16/CCITT-FALSE check value (`"123456789"` → `0x29B1`), rather than whatever our own builder currently emits. `cycles.test.ts` does the same with `SPREADSHEET_COLUMNS`: the twelve payday→month pairings transcribed from the user's own spreadsheet, written by hand long before this code existed.
- **Time is faked, not observed.** Anything cycle- or date-filtered (`budget`, `dashboard`) pins "today" with `vi.setSystemTime`, or the suite starts failing on a date that isn't the one it was written on.
