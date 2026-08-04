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

// SHEETS_MOCK_MODE stand-in for the MasterItems / PriceHistory tabs (see
// SETUP.md) — lets the scan -> confirm loop run end-to-end before the
// user has created a real Sheet + service account. Resets on restart.
const mockMasterItems: MasterItem[] = [];
const mockPriceHistory: PriceHistoryRow[] = [];

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
