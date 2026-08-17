# Setup: Google Sheets database

The `/controller` service needs a real Google Sheet and a service account to talk to it. Neither exists yet — these are manual, one-time steps only you can do (they need your own Google account). Everything works locally without this via `SHEETS_MOCK_MODE=true` (the default), so you can develop and test first and do this whenever you're ready to go live.

## 1. Create the Google Sheet

**Shortcut:** `scripts/setup-sheet.gs` builds every tab below for you. Open the Sheet → **Extensions → Apps Script**, paste that file in, save, and run `setUpTrackerSheet`. It creates only the tabs that are missing and leaves existing ones completely untouched, so it's safe on a Sheet already in use — and it sets the column formats that keep `2026-01` from turning into a date. It also seeds the `Cycles` tab with a row per month of the current year, ready for your paydays.

The same file has a `checkTrackerSheet` you can run afterwards: it reads nothing but reports, and tells you if any dated column comes back in a format the controller will reject. Worth running on a Sheet that predates these tabs, since `setUpTrackerSheet` deliberately won't reformat one that already exists.

The rest of this section is the reference for what the script builds (or for doing it by hand).

Create a new Google Sheet with nine tabs, each with an exact header row in row 1:

**Tab `MasterItems`**
| Name | Category | CreatedAt |
|------|----------|-----------|

**Tab `PriceHistory`**
| Date | Store | MasterItemName | Category | Price | Quantity | ID | Discount |
|------|-------|-----------------|----------|-------|----------|-----|----------|

`Price` is **per unit and before any discount**, `Quantity` multiplies it,
and `Discount` comes off the line as a whole. **What was paid is
`Price × Quantity − Discount`.**

Keeping the discount separate is deliberate: the price history's job is what
a product normally costs, and a promo that won't be there next time
shouldn't become its remembered price. Blank `Quantity` counts as 1 and
blank `Discount` as 0, so rows written before those columns existed still
read correctly.

A discount off the **whole bill** is stored as its own row — `Price` 0 with
the amount in `Discount`, so it totals to a negative without any negative
price existing anywhere. Rows like that are skipped by the price search.

⚠️ **If your Sheet already has this tab**, add the missing columns by hand —
`setUpTrackerSheet` never touches a tab that already exists, and
`checkTrackerSheet` will tell you which ones are missing. Until you do,
scanning still works and existing rows read fine, but rows can't be edited
or deleted (`ID` identifies a row) and discounts aren't recorded.

**Tab `MustPay`**
| ID | Name | Amount | Month | Status | PaidAt | RecurringGroupKey |
|----|------|--------|-------|--------|--------|-------------------|

(`Month` is a pay-cycle key, `YYYY-MM`; `Status` is `unpaid` or `paid`.
`RecurringGroupKey` is set only on a row the app generated from a
`RecurringBills` entry — blank for anything typed in by hand. Blank also
reads correctly on rows written before this column existed.)

⚠️ **If your Sheet already has this tab**, add the `RecurringGroupKey`
column by hand — `setUpTrackerSheet` never touches a tab that already
exists. Until you do, everything else on this tab works fine; only
recurring-bill generation is affected (it would create a duplicate row
each cycle instead of recognising the one it already made).

**Tab `RecurringBills`**
| ID | Name | Amount | CardGroup | InstallmentsRemaining | Active | LastBilledCycle |
|----|------|--------|-----------|------------------------|--------|------------------|

A template, not a per-cycle row: the app creates one `MustPay` row from
each active bill here the first time a new cycle is opened, tagging it
with this row's `ID` (or `CardGroup`, if set) as `RecurringGroupKey` so it
knows not to create a second one. `InstallmentsRemaining` blank means no
end date (rent, utilities) — a number counts down by one each time it
generates a row and the bill goes `Active` = `false` on its own at zero,
the way an instalment plan actually ends. Several bills sharing the same
`CardGroup` collapse into a single `MustPay` row each cycle, named for the
card and summing their amounts — one card statement, not one transfer per
thing on it. Adding a second or third bill to a `CardGroup` whose row for
this cycle already exists updates that row's amount instead of leaving it
stuck at whatever the group summed to when the row was first generated.
`LastBilledCycle` is the cycle key (`YYYY-MM`) this bill's instalment was
last counted down for — blank means never billed — and is what stops a
bill already counted this cycle from having its `InstallmentsRemaining`
decremented a second time once its group's row gets recomputed for a
newly added bill.

⚠️ **If your Sheet already has this tab**, add the `LastBilledCycle`
header by hand for clarity — `setUpTrackerSheet` never touches a tab that
already exists. The app reads and writes column G by position regardless
of whether row 1 labels it, so this is cosmetic; nothing behaves
differently either way.

**Tab `Cycles`**
| CycleKey | PaydayDate | SavingsBalance |
|----------|------------|----------------|

One row per pay cycle. `CycleKey` is `YYYY-MM`, `PaydayDate` is the day the
salary actually landed (`YYYY-MM-DD`), `SavingsBalance` is that cycle's
closing balance in the savings account — read off the bank, since money can
leave that account without passing through the app. A cycle runs from its
payday to the day before the next one, and is named for the month whose 15th
falls inside it, so a payday on 26 Dec 2025 belongs to cycle `2026-01`. You
can fill in the whole year at once from the app's แดชบอร์ด page; any month
left blank is estimated from the nearest one you did enter.

**Tab `PendingSavings`**
| ID | Date | Store | MasterItemName | Category | Price | Quantity | Discount | CreatedAt |
|----|------|-------|-----------------|----------|-------|----------|-----------|-----------|

A line marked "paid from savings" on the receipt-review screen lands here
instead of `PriceHistory` — it isn't a recorded expense yet. It moves to
`PriceHistory` (same columns, same meaning) once the transfer-back QR is
confirmed on the SavingsQR page, using this row's own `Date` rather than
the confirmation date, so a purchase near the end of a pay cycle can't jump
into the wrong one just because it was confirmed later. Confirming or
cancelling it removes the row from here.

**Tab `SlipPayees`**
| PayeeName | StoreName |
|-----------|-----------|

Maps a transfer slip's registered payee name (e.g. `ร้านถุงเงิน (แซ่บเล้ง
แอนด์ หม่าล่านายเบิร์ด)`, rarely how you'd type that store's name yourself)
to the store name you actually want recorded. Written automatically the
first time a slip-scanned receipt for that payee is confirmed, and read
back to prefill the store field the next time the same payee shows up —
nothing to fill in by hand.

**Tab `Income`**
| ID | Date | Source | Amount |
|----|------|--------|--------|

**Tab `Settings`**
| Key | Value |
|-----|-------|

Three keys, all optional — the app falls back to the defaults in brackets if
a row is missing or blank: `opening_balance` [0] is the spending account's
starting balance, from which the dashboard runs its balance forward;
`cycle_budget_food` [5000] and `cycle_budget_goods` [5000] are the caps
**per pay cycle**, not per day.

Leave the tabs otherwise empty — rows get appended by the app.

Copy the spreadsheet ID out of its URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.

## 2. Create a GCP service account

1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create a project (or reuse one).
2. Enable the **Google Sheets API** for that project.
3. Go to **IAM & Admin → Service Accounts → Create Service Account**. Any name is fine.
4. Open the new service account → **Keys → Add Key → Create new key → JSON**. This downloads a `.json` key file — keep it out of git (it's covered by `.gitignore`'s `*-service-account.json` pattern; name the file accordingly, or add its exact name to `.gitignore` yourself).

## 3. Share the Sheet with the service account

Open the Google Sheet, click **Share**, and add the service account's email (looks like `something@your-project.iam.gserviceaccount.com`, visible on its details page) with **Editor** access.

## 4. Configure the controller

In `controller/.env` (copy from `controller/.env.example`):

```
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./path/to/the-downloaded-key.json
SHEETS_SPREADSHEET_ID=<the ID from step 1>
SHEETS_MOCK_MODE=false
```

Restart the controller. All of `controller/src/sheets/client.ts` (master items, price history, pending savings transfers, must-pay, recurring bills, cycles, slip payees, income, settings) now hits the real Sheet instead of the in-memory mock.
