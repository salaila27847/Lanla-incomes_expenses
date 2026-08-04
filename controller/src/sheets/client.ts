import { randomUUID } from "crypto";
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID ?? "";
const MOCK_MODE = (process.env.SHEETS_MOCK_MODE ?? "true").toLowerCase() === "true";

// Direct equivalent of what Apps Script's SpreadsheetApp gave for free:
// a service account authenticated against the Sheets API. See SETUP.md
// for creating one, enabling the Sheets API, and sharing the target
// Sheet with the service account's email.
function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
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

export type ItemCategory = "food" | "goods";

export interface MasterItem {
  name: string;
  category: ItemCategory;
}

export interface PriceHistoryRow {
  date: string;
  store: string | null;
  masterItemName: string;
  category: ItemCategory;
  price: number;
}

export type MustPayStatus = "unpaid" | "paid";

export interface MustPayItem {
  id: string;
  name: string;
  amount: number;
  month: string; // YYYY-MM
  status: MustPayStatus;
  paidAt: string | null;
}

// SHEETS_MOCK_MODE stand-in for the MasterItems / PriceHistory / MustPay
// tabs (see SETUP.md) — lets the app run end-to-end before the user has
// created a real Sheet + service account. Resets on restart.
const mockMasterItems: MasterItem[] = [];
const mockPriceHistory: PriceHistoryRow[] = [];
const mockMustPayItems: MustPayItem[] = [];

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

export async function appendPriceHistoryRow(row: PriceHistoryRow): Promise<void> {
  if (MOCK_MODE) {
    mockPriceHistory.push(row);
    return;
  }
  await appendRow("PriceHistory!A:E", [
    row.date,
    row.store ?? "",
    row.masterItemName,
    row.category,
    row.price,
  ]);
}

export async function readPriceHistory(): Promise<PriceHistoryRow[]> {
  if (MOCK_MODE) {
    return mockPriceHistory;
  }
  const rows = await readRange("PriceHistory!A2:E");
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      date: String(row[0]),
      store: row[1] ? String(row[1]) : null,
      masterItemName: String(row[2]),
      category: row[3] === "goods" ? "goods" : "food",
      price: Number(row[4]),
    }));
}

export async function readMustPayItems(): Promise<MustPayItem[]> {
  if (MOCK_MODE) {
    return mockMustPayItems;
  }
  const rows = await readRange("MustPay!A2:F");
  return rows
    .filter((row) => row[0])
    .map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      amount: Number(row[2]),
      month: String(row[3]),
      status: row[4] === "paid" ? "paid" : "unpaid",
      paidAt: row[5] ? String(row[5]) : null,
    }));
}

export async function appendMustPayItem(input: {
  name: string;
  amount: number;
  month: string;
}): Promise<MustPayItem> {
  const item: MustPayItem = {
    id: randomUUID(),
    name: input.name,
    amount: input.amount,
    month: input.month,
    status: "unpaid",
    paidAt: null,
  };
  if (MOCK_MODE) {
    mockMustPayItems.push(item);
    return item;
  }
  await appendRow("MustPay!A:F", [item.id, item.name, item.amount, item.month, item.status, ""]);
  return item;
}

export async function updateMustPayStatus(id: string, status: MustPayStatus): Promise<void> {
  const paidAt = status === "paid" ? new Date().toISOString() : null;

  if (MOCK_MODE) {
    const item = mockMustPayItems.find((mustPay) => mustPay.id === id);
    if (item) {
      item.status = status;
      item.paidAt = paidAt;
    }
    return;
  }

  const ids = await readRange("MustPay!A2:A");
  const rowIndex = ids.findIndex((row) => row[0] === id);
  if (rowIndex === -1) return;
  const rowNumber = rowIndex + 2; // header is row 1, data starts at row 2
  await updateRange(`MustPay!E${rowNumber}:F${rowNumber}`, [status, paidAt ?? ""]);
}
