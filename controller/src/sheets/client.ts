import { randomUUID } from "crypto";
import { google } from "googleapis";
import { env, envFlag } from "../env";

const SPREADSHEET_ID = env("SHEETS_SPREADSHEET_ID");
const MOCK_MODE = envFlag("SHEETS_MOCK_MODE", true);

// Direct equivalent of what Apps Script's SpreadsheetApp gave for free:
// a service account authenticated against the Sheets API. See SETUP.md
// for creating one, enabling the Sheets API, and sharing the target
// Sheet with the service account's email.
//
// GOOGLE_SERVICE_ACCOUNT_KEY_JSON (the key file's contents, as one env
// var) takes priority over GOOGLE_SERVICE_ACCOUNT_KEY_PATH (a local file
// path) — serverless hosts like Vercel have no on-disk key file to point
// at, since it's gitignored, so production deployments use the JSON var
// while local dev can keep using the file path. See DEPLOY.md.
function getSheetsClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  const auth = new google.auth.GoogleAuth(
    keyJson
      ? { credentials: JSON.parse(keyJson), scopes: ["https://www.googleapis.com/auth/spreadsheets"] }
      : {
          keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        },
  );
  return google.sheets({ version: "v4", auth });
}

async function readRange(range: string): Promise<unknown[][]> {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  return response.data.values ?? [];
}

async function appendRow(range: string, values: unknown[]): Promise<void> {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

async function updateRange(range: string, values: unknown[]): Promise<void> {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

/**
 * Reads a range from a tab that may not exist yet.
 *
 * Cycles, Income and Settings were added after the first Sheets went into
 * use, and the API answers a missing tab with a 400 "Unable to parse range"
 * rather than an empty result. Left unhandled that turns a Sheet created
 * before those tabs existed into a 500 on the Budget page — one that works
 * fine today. Treating it as "no rows" lets every page keep rendering on
 * defaults until the tabs from SETUP.md are added.
 *
 * Writes deliberately still throw: a failed save must not look like it
 * worked.
 */
async function readOptionalRange(range: string): Promise<unknown[][]> {
  try {
    return await readRange(range);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unable to parse range/i.test(message)) throw error;
    console.warn(`[sheets] no "${range.split("!")[0]}" tab yet — see SETUP.md. Using defaults.`);
    return [];
  }
}

// Row number of the first row whose first column equals `value`, for the
// read-then-write updates below. Header is row 1, so data starts at row 2.
async function findRowNumber(keyColumnRange: string, value: string): Promise<number | null> {
  const rows = await readRange(keyColumnRange);
  const index = rows.findIndex((row) => row[0] === value);
  return index === -1 ? null : index + 2;
}

// Amounts can be typed straight into the Sheet by hand, and "1,200" is a
// perfectly natural thing to type. Number() turns that into NaN, which
// would then poison every total it feeds.
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

// Distinguishes "the user left this blank" from "the user entered 0" —
// a blank savings balance means unknown, not an empty account.
function toOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return toNumber(value);
}

export type ItemCategory = "food" | "goods";

export interface MasterItem {
  name: string;
  category: ItemCategory;
}

export interface PriceHistoryRow {
  /** A UUID for rows written since the ID column existed. Rows older than
   *  it get a synthetic `row:<n>` handle so they stay editable too. */
  id: string;
  date: string;
  store: string | null;
  masterItemName: string;
  /** Per unit, before any discount. Kept at the printed price so the price
   *  history stays comparable across stores — a promo you can't count on
   *  next time shouldn't become the product's remembered price. */
  price: number;
  quantity: number;
  /** Taken off this line as a whole, not per unit. What was actually paid
   *  is `price * quantity - discount`. A row whose price is 0 and whose
   *  discount isn't is a bill-level discount rather than a product. */
  discount: number;
  category: ItemCategory;
}

export type PriceHistoryInput = Omit<PriceHistoryRow, "id" | "quantity" | "discount"> & {
  quantity?: number;
  discount?: number;
};

/** What the line actually cost. The only correct way to sum money here. */
export function lineTotal(row: Pick<PriceHistoryRow, "price" | "quantity" | "discount">): number {
  return row.price * row.quantity - row.discount;
}

/** True for a bill-level discount row: an amount off the whole receipt that
 *  no single product accounts for. Not a price, so price history skips it. */
export function isDiscountOnly(row: Pick<PriceHistoryRow, "price" | "discount">): boolean {
  return row.price === 0 && row.discount > 0;
}

// A line paid straight out of the savings account isn't a recorded expense
// yet — it sits here until the transfer-back QR is actually confirmed, so
// the record of "money left savings" is tied to the real-world action
// instead of a box someone has to remember to check later. Same shape as
// PriceHistoryRow (minus id/createdAt semantics) so confirming it is just
// appendPriceHistoryRow with this row's own data, unchanged.
export interface PendingSavingsItem {
  id: string;
  date: string;
  store: string | null;
  masterItemName: string;
  category: ItemCategory;
  price: number;
  quantity: number;
  discount: number;
  createdAt: string;
}

export type MustPayStatus = "unpaid" | "paid";

export interface MustPayItem {
  id: string;
  name: string;
  amount: number;
  month: string; // a pay-cycle key (YYYY-MM), see src/cycles.ts
  status: MustPayStatus;
  paidAt: string | null;
  /** Which RecurringBill (or, for a shared card, its cardGroup name)
   *  generated this row — null for a manually-added one-off. Lets
   *  generateRecurringMustPay tell "already created this cycle" apart
   *  from "the user typed the same name by hand". */
  recurringGroupKey: string | null;
}

// A recurring bill isn't a MustPay row itself — it's the template that
// generates one each cycle, since a single cycle's row can be edited or
// marked paid independently of the template it came from.
//
// installmentsRemaining is null for something with no natural end (rent,
// utilities): it recurs forever. A number counts down each time it
// generates a row and the bill goes inactive at zero, so an instalment
// plan stops on its own instead of needing to be remembered and cancelled.
//
// cardGroup lets several instalments billed through the same card collapse
// into one MustPay row each cycle — what you actually pay is one card
// statement, not one transfer per product on it.
export interface RecurringBill {
  id: string;
  name: string;
  amount: number;
  cardGroup: string | null;
  installmentsRemaining: number | null;
  active: boolean;
}

export interface CycleRow {
  key: string; // YYYY-MM
  payday: string | null; // YYYY-MM-DD
  savingsBalance: number | null;
}

export interface IncomeEntry {
  id: string;
  date: string; // YYYY-MM-DD
  source: string;
  amount: number;
}

export type SettingsMap = Record<string, string>;

// SHEETS_MOCK_MODE stand-in for the MasterItems / PriceHistory / MustPay /
// Cycles / Income / Settings tabs (see SETUP.md) — lets the app run
// end-to-end before the user has created a real Sheet + service account.
// Resets on restart.
const mockMasterItems: MasterItem[] = [];
const mockPriceHistory: PriceHistoryRow[] = [];
const mockMustPayItems: MustPayItem[] = [];
const mockPendingSavingsItems: PendingSavingsItem[] = [];
const mockRecurringBills: RecurringBill[] = [];
const mockCycleRows: CycleRow[] = [];
const mockIncome: IncomeEntry[] = [];
const mockSettings: SettingsMap = {};

export async function readMasterItems(): Promise<MasterItem[]> {
  if (MOCK_MODE) {
    return mockMasterItems;
  }
  const rows = await readRange("MasterItems!A2:B");
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      name: String(row[0]),
      category: row[1] === "goods" ? "goods" : "food",
    }));
}

export async function appendMasterItem(name: string, category: ItemCategory): Promise<void> {
  if (MOCK_MODE) {
    mockMasterItems.push({ name, category });
    return;
  }
  await appendRow("MasterItems!A:C", [name, category, new Date().toISOString()]);
}

function priceHistoryValues(row: PriceHistoryRow): unknown[] {
  return [
    row.date,
    row.store ?? "",
    row.masterItemName,
    row.category,
    row.price,
    row.quantity,
    row.id,
    row.discount,
  ];
}

export async function appendPriceHistoryRow(input: PriceHistoryInput): Promise<PriceHistoryRow> {
  const row: PriceHistoryRow = {
    ...input,
    id: randomUUID(),
    quantity: input.quantity ?? 1,
    discount: input.discount ?? 0,
  };
  if (MOCK_MODE) {
    mockPriceHistory.push(row);
    return row;
  }
  await appendRow("PriceHistory!A:H", priceHistoryValues(row));
  return row;
}

export async function readPriceHistory(): Promise<PriceHistoryRow[]> {
  if (MOCK_MODE) {
    return mockPriceHistory;
  }
  const rows = await readRange("PriceHistory!A2:H");
  return rows
    .map((row, index) => ({ row, rowNumber: index + 2 }))
    .filter(({ row }) => row[0])
    .map(({ row, rowNumber }) => ({
      // Rows written before the ID column existed have nothing in G, and
      // they're the ones most likely to need correcting. Their row number
      // stands in — safe because deletes blank a row rather than removing
      // it, so no other row's number ever shifts.
      id: row[6] ? String(row[6]) : `row:${rowNumber}`,
      date: String(row[0]),
      store: row[1] ? String(row[1]) : null,
      masterItemName: String(row[2]),
      category: row[3] === "goods" ? "goods" : "food",
      price: toNumber(row[4]),
      // Blank means one, matching every row written before the column
      // existed. Zero would erase the line from every total.
      quantity: toOptionalNumber(row[5]) ?? 1,
      // Blank means no discount, which is what every row written before
      // this column existed is. toNumber already reads blank as 0, so
      // unlike quantity there's no "not entered" case to preserve here.
      discount: toNumber(row[7]),
    }));
}

/** Row number for either ID form, or null if it's gone. */
async function priceHistoryRowNumber(id: string): Promise<number | null> {
  if (id.startsWith("row:")) {
    const rowNumber = Number(id.slice(4));
    return Number.isInteger(rowNumber) && rowNumber >= 2 ? rowNumber : null;
  }
  return findRowNumber("PriceHistory!G2:G", id);
}

export async function updatePriceHistoryRow(
  id: string,
  updates: Partial<PriceHistoryInput>,
): Promise<PriceHistoryRow | null> {
  const existing = (await readPriceHistory()).find((row) => row.id === id);
  if (!existing) return null;

  const merged: PriceHistoryRow = {
    ...existing,
    ...Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined)),
  };

  if (MOCK_MODE) {
    const index = mockPriceHistory.findIndex((row) => row.id === id);
    if (index !== -1) mockPriceHistory[index] = merged;
    return merged;
  }

  const rowNumber = await priceHistoryRowNumber(id);
  if (rowNumber === null) return null;
  // A pre-ID row keeps its row: handle rather than gaining a UUID, so the
  // handle the caller is holding stays valid.
  const values = priceHistoryValues(merged);
  await updateRange(`PriceHistory!A${rowNumber}:H${rowNumber}`, [
    ...values.slice(0, 6),
    id.startsWith("row:") ? "" : id,
    values[7],
  ]);
  return merged;
}

export async function deletePriceHistoryRow(id: string): Promise<boolean> {
  if (MOCK_MODE) {
    const index = mockPriceHistory.findIndex((row) => row.id === id);
    if (index === -1) return false;
    mockPriceHistory.splice(index, 1);
    return true;
  }

  // Checked against the rows that actually exist, not just parsed: a stale
  // `row:99` handle is well-formed but points at nothing, and blanking an
  // empty row would report a deletion that never happened.
  if (!(await readPriceHistory()).some((row) => row.id === id)) return false;

  const rowNumber = await priceHistoryRowNumber(id);
  if (rowNumber === null) return false;
  // Blanked, not removed — see the note on `row:<n>` above, and deleteIncome.
  await updateRange(`PriceHistory!A${rowNumber}:H${rowNumber}`, ["", "", "", "", "", "", "", ""]);
  return true;
}

// --- Pending savings transfers -----------------------------------------
// A tab added after the original six in SETUP.md, so a Sheet that
// predates it has no "PendingSavings" tab yet — readOptionalRange treats
// that as zero rows instead of a 500, same as Cycles/Income/Settings.

export async function readPendingSavingsItems(): Promise<PendingSavingsItem[]> {
  if (MOCK_MODE) {
    return mockPendingSavingsItems;
  }
  const rows = await readOptionalRange("PendingSavings!A2:I");
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      id: String(row[0]),
      date: String(row[1]),
      store: row[2] ? String(row[2]) : null,
      masterItemName: String(row[3]),
      category: row[4] === "goods" ? "goods" : "food",
      price: toNumber(row[5]),
      quantity: toOptionalNumber(row[6]) ?? 1,
      discount: toNumber(row[7]),
      createdAt: String(row[8]),
    }));
}

export async function appendPendingSavingsItem(
  input: Omit<PendingSavingsItem, "id" | "createdAt">,
): Promise<PendingSavingsItem> {
  const item: PendingSavingsItem = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  if (MOCK_MODE) {
    mockPendingSavingsItems.push(item);
    return item;
  }
  await appendRow("PendingSavings!A:I", [
    item.id,
    item.date,
    item.store ?? "",
    item.masterItemName,
    item.category,
    item.price,
    item.quantity,
    item.discount,
    item.createdAt,
  ]);
  return item;
}

export async function deletePendingSavingsItem(id: string): Promise<boolean> {
  if (MOCK_MODE) {
    const index = mockPendingSavingsItems.findIndex((item) => item.id === id);
    if (index === -1) return false;
    mockPendingSavingsItems.splice(index, 1);
    return true;
  }

  const rowNumber = await findRowNumber("PendingSavings!A2:A", id);
  if (rowNumber === null) return false;
  // Blanked, not removed — same reasoning as every other delete here.
  await updateRange(`PendingSavings!A${rowNumber}:I${rowNumber}`, [
    "", "", "", "", "", "", "", "", "",
  ]);
  return true;
}

export async function readMustPayItems(): Promise<MustPayItem[]> {
  if (MOCK_MODE) {
    return mockMustPayItems;
  }
  // Column G (recurringGroupKey) postdates the original six columns, so a
  // row written before it exists simply has nothing there — row[6] reads
  // as undefined, same blank-means-null handling as PaidAt.
  const rows = await readRange("MustPay!A2:G");
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      amount: toNumber(row[2]),
      month: String(row[3]),
      status: row[4] === "paid" ? "paid" : "unpaid",
      paidAt: row[5] ? String(row[5]) : null,
      recurringGroupKey: row[6] ? String(row[6]) : null,
    }));
}

export async function appendMustPayItem(input: {
  name: string;
  amount: number;
  month: string;
  recurringGroupKey?: string | null;
}): Promise<MustPayItem> {
  const item: MustPayItem = {
    id: randomUUID(),
    name: input.name,
    amount: input.amount,
    month: input.month,
    status: "unpaid",
    paidAt: null,
    recurringGroupKey: input.recurringGroupKey ?? null,
  };
  if (MOCK_MODE) {
    mockMustPayItems.push(item);
    return item;
  }
  await appendRow("MustPay!A:G", [
    item.id,
    item.name,
    item.amount,
    item.month,
    item.status,
    "",
    item.recurringGroupKey ?? "",
  ]);
  return item;
}

export async function updateMustPayStatus(
  id: string,
  status: MustPayStatus,
): Promise<boolean> {
  // Going back to unpaid clears the timestamp: a paidAt left behind on an
  // unpaid row is a contradiction the sheet would carry indefinitely.
  const paidAt = status === "paid" ? new Date().toISOString() : null;

  if (MOCK_MODE) {
    const item = mockMustPayItems.find((mustPay) => mustPay.id === id);
    if (!item) return false;
    item.status = status;
    item.paidAt = paidAt;
    return true;
  }

  const rowNumber = await findRowNumber("MustPay!A2:A", id);
  if (rowNumber === null) return false;
  await updateRange(`MustPay!E${rowNumber}:F${rowNumber}`, [status, paidAt ?? ""]);
  return true;
}

export async function deleteMustPayItem(id: string): Promise<boolean> {
  if (MOCK_MODE) {
    const index = mockMustPayItems.findIndex((item) => item.id === id);
    if (index === -1) return false;
    mockMustPayItems.splice(index, 1);
    return true;
  }

  const rowNumber = await findRowNumber("MustPay!A2:A", id);
  if (rowNumber === null) return false;
  // Blanked, not removed, like every other delete here — readMustPayItems
  // skips rows with no ID, and leaving row numbers stable keeps concurrent
  // reads from landing on the wrong row.
  await updateRange(`MustPay!A${rowNumber}:G${rowNumber}`, ["", "", "", "", "", "", ""]);
  return true;
}

// --- Recurring bills ----------------------------------------------------
// Templates that generate a MustPay row for the current cycle the first
// time it's asked for (see generateRecurringMustPay in routes/budget.ts).
// A tab added after the original six/seven, so a Sheet that predates it
// has no "RecurringBills" tab yet — readOptionalRange treats that as zero
// rows instead of a 500, same as PendingSavings.

export async function readRecurringBills(): Promise<RecurringBill[]> {
  if (MOCK_MODE) {
    return mockRecurringBills;
  }
  const rows = await readOptionalRange("RecurringBills!A2:F");
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      amount: toNumber(row[2]),
      cardGroup: row[3] ? String(row[3]) : null,
      installmentsRemaining: toOptionalNumber(row[4]),
      active: row[5] !== "false",
    }));
}

export async function appendRecurringBill(input: {
  name: string;
  amount: number;
  cardGroup?: string | null;
  installmentsRemaining?: number | null;
}): Promise<RecurringBill> {
  const bill: RecurringBill = {
    id: randomUUID(),
    name: input.name,
    amount: input.amount,
    cardGroup: input.cardGroup ?? null,
    installmentsRemaining: input.installmentsRemaining ?? null,
    active: true,
  };
  if (MOCK_MODE) {
    mockRecurringBills.push(bill);
    return bill;
  }
  await appendRow("RecurringBills!A:F", [
    bill.id,
    bill.name,
    bill.amount,
    bill.cardGroup ?? "",
    bill.installmentsRemaining ?? "",
    "true",
  ]);
  return bill;
}

/** Applied after generating this cycle's row for a bill: counts its
 *  instalment down, deactivating at zero so it stops generating on its
 *  own — see the note on RecurringBill for why that matters. */
export async function updateRecurringBill(
  id: string,
  updates: { installmentsRemaining?: number | null; active?: boolean },
): Promise<RecurringBill | null> {
  const existing = (await readRecurringBills()).find((bill) => bill.id === id);
  if (!existing) return null;
  const merged: RecurringBill = { ...existing, ...updates };

  if (MOCK_MODE) {
    const index = mockRecurringBills.findIndex((bill) => bill.id === id);
    if (index !== -1) mockRecurringBills[index] = merged;
    return merged;
  }

  const rowNumber = await findRowNumber("RecurringBills!A2:A", id);
  if (rowNumber === null) return null;
  await updateRange(`RecurringBills!E${rowNumber}:F${rowNumber}`, [
    merged.installmentsRemaining ?? "",
    String(merged.active),
  ]);
  return merged;
}

export async function deleteRecurringBill(id: string): Promise<boolean> {
  if (MOCK_MODE) {
    const index = mockRecurringBills.findIndex((bill) => bill.id === id);
    if (index === -1) return false;
    mockRecurringBills.splice(index, 1);
    return true;
  }

  const rowNumber = await findRowNumber("RecurringBills!A2:A", id);
  if (rowNumber === null) return false;
  await updateRange(`RecurringBills!A${rowNumber}:F${rowNumber}`, ["", "", "", "", "", ""]);
  return true;
}

// --- Slip payees --------------------------------------------------------
// A transfer slip's registered payee name ("ร้านถุงเงิน (แซ่บเล้ง แอนด์
// หม่าล่านายเบิร์ด)") is rarely how the user refers to that store
// elsewhere in the app, so this tab remembers the mapping the first time a
// slip is confirmed and prefills the store field the next time the same
// payee shows up. A tab added after the original eight, so a Sheet that
// predates it has no "SlipPayees" tab yet -- readOptionalRange treats that
// as zero rows instead of a 500, same as PendingSavings/RecurringBills.

export interface SlipPayeeMapping {
  payee: string;
  storeName: string;
}

const mockSlipPayees: SlipPayeeMapping[] = [];

export async function readSlipPayeeMap(): Promise<SlipPayeeMapping[]> {
  if (MOCK_MODE) {
    return mockSlipPayees;
  }
  const rows = await readOptionalRange("SlipPayees!A2:B");
  return rows
    .filter((row) => row[0])
    .map((row) => ({ payee: String(row[0]), storeName: String(row[1] ?? "") }));
}

/** The store name a slip's payee has been recorded as before, or null on a
 *  payee seen for the first time. Exact match on the trimmed payee text --
 *  the same slip issuer always prints the same registered name, so nothing
 *  fuzzier is needed here the way it is for OCR'd product names. */
export async function findStoreForPayee(payee: string): Promise<string | null> {
  const trimmed = payee.trim();
  if (!trimmed) return null;
  const match = (await readSlipPayeeMap()).find((entry) => entry.payee === trimmed);
  return match?.storeName ?? null;
}

export async function upsertSlipPayeeMapping(payee: string, storeName: string): Promise<void> {
  const trimmedPayee = payee.trim();
  const trimmedStore = storeName.trim();
  if (!trimmedPayee || !trimmedStore) return;

  if (MOCK_MODE) {
    const index = mockSlipPayees.findIndex((entry) => entry.payee === trimmedPayee);
    const entry = { payee: trimmedPayee, storeName: trimmedStore };
    if (index === -1) mockSlipPayees.push(entry);
    else mockSlipPayees[index] = entry;
    return;
  }

  const rowNumber = await findRowNumber("SlipPayees!A2:A", trimmedPayee);
  if (rowNumber === null) await appendRow("SlipPayees!A:B", [trimmedPayee, trimmedStore]);
  else await updateRange(`SlipPayees!A${rowNumber}:B${rowNumber}`, [trimmedPayee, trimmedStore]);
}

// --- Cycles -----------------------------------------------------------
// One row per pay cycle: the payday the user entered (they know the whole
// year in advance) and the savings-account balance they read off their
// bank at the end of it. Both are user-supplied — the payday because it
// shifts with weekends and holidays, the balance because money sometimes
// leaves the savings account directly and can't be derived from what the
// app has recorded.

export async function readCycleRows(): Promise<CycleRow[]> {
  if (MOCK_MODE) {
    return mockCycleRows;
  }
  const rows = await readOptionalRange("Cycles!A2:C");
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      key: String(row[0]),
      payday: row[1] ? String(row[1]) : null,
      savingsBalance: toOptionalNumber(row[2]),
    }));
}

/**
 * Writes one cycle's row, creating it if the key is new. Fields left
 * `undefined` keep whatever is already stored, so setting a payday doesn't
 * wipe a savings balance entered earlier (and vice versa).
 */
export async function upsertCycleRow(update: {
  key: string;
  payday?: string | null;
  savingsBalance?: number | null;
}): Promise<CycleRow> {
  const existing = (await readCycleRows()).find((row) => row.key === update.key);
  const merged: CycleRow = {
    key: update.key,
    payday: update.payday === undefined ? (existing?.payday ?? null) : update.payday,
    savingsBalance:
      update.savingsBalance === undefined
        ? (existing?.savingsBalance ?? null)
        : update.savingsBalance,
  };

  if (MOCK_MODE) {
    const index = mockCycleRows.findIndex((row) => row.key === update.key);
    if (index === -1) mockCycleRows.push(merged);
    else mockCycleRows[index] = merged;
    return merged;
  }

  const values = [merged.key, merged.payday ?? "", merged.savingsBalance ?? ""];
  const rowNumber = await findRowNumber("Cycles!A2:A", update.key);
  if (rowNumber === null) await appendRow("Cycles!A:C", values);
  else await updateRange(`Cycles!A${rowNumber}:C${rowNumber}`, values);
  return merged;
}

// --- Income -----------------------------------------------------------

export async function readIncome(): Promise<IncomeEntry[]> {
  if (MOCK_MODE) {
    return mockIncome;
  }
  const rows = await readOptionalRange("Income!A2:D");
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      id: String(row[0]),
      date: String(row[1]),
      source: String(row[2]),
      amount: toNumber(row[3]),
    }));
}

export async function appendIncome(input: {
  date: string;
  source: string;
  amount: number;
}): Promise<IncomeEntry> {
  const entry: IncomeEntry = { id: randomUUID(), ...input };
  if (MOCK_MODE) {
    mockIncome.push(entry);
    return entry;
  }
  await appendRow("Income!A:D", [entry.id, entry.date, entry.source, entry.amount]);
  return entry;
}

export async function deleteIncome(id: string): Promise<void> {
  if (MOCK_MODE) {
    const index = mockIncome.findIndex((entry) => entry.id === id);
    if (index !== -1) mockIncome.splice(index, 1);
    return;
  }
  // Blanking the row rather than removing it: deleting a row needs
  // batchUpdate + the tab's numeric sheetId, a whole second API surface,
  // and every read here already skips rows with no ID.
  const rowNumber = await findRowNumber("Income!A2:A", id);
  if (rowNumber === null) return;
  await updateRange(`Income!A${rowNumber}:D${rowNumber}`, ["", "", "", ""]);
}

// --- Settings ---------------------------------------------------------
// Key/value so a new setting needs no schema change — and so the user can
// read and edit them in the Sheet directly.

export async function readSettings(): Promise<SettingsMap> {
  if (MOCK_MODE) {
    return { ...mockSettings };
  }
  const rows = await readOptionalRange("Settings!A2:B");
  return Object.fromEntries(
    rows.filter((row) => row[0]).map((row) => [String(row[0]), String(row[1] ?? "")]),
  );
}

export async function writeSettings(updates: SettingsMap): Promise<void> {
  if (MOCK_MODE) {
    Object.assign(mockSettings, updates);
    return;
  }
  for (const [key, value] of Object.entries(updates)) {
    const rowNumber = await findRowNumber("Settings!A2:A", key);
    if (rowNumber === null) await appendRow("Settings!A:B", [key, value]);
    else await updateRange(`Settings!A${rowNumber}:B${rowNumber}`, [key, value]);
  }
}
