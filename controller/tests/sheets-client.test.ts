/**
 * The Sheets client is the only thing that touches the database, and it
 * has two very different modes: an in-memory stand-in (SHEETS_MOCK_MODE,
 * the default so the app runs before a real Sheet exists) and the real
 * Sheets API. Both need to agree on the shapes they return, or the app
 * behaves differently in mock mode than in production.
 *
 * SHEETS_MOCK_MODE and the in-memory tabs are captured at module scope,
 * so every test re-imports the module with the environment it wants.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadClient(env: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("SHEETS_MOCK_MODE", env.SHEETS_MOCK_MODE ?? "true");
  vi.stubEnv("SHEETS_SPREADSHEET_ID", env.SHEETS_SPREADSHEET_ID ?? "");
  return import("../src/sheets/client");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("mock mode", () => {
  it("starts empty so a fresh install has no phantom data", async () => {
    const client = await loadClient();

    expect(await client.readMasterItems()).toEqual([]);
    expect(await client.readPriceHistory()).toEqual([]);
    expect(await client.readMustPayItems()).toEqual([]);
  });

  it("reads back what it wrote", async () => {
    const client = await loadClient();

    await client.appendMasterItem("นมสด UHT 250ml", "food");
    await client.appendPriceHistoryRow({
      date: "2026-08-04",
      store: "7-Eleven",
      masterItemName: "นมสด UHT 250ml",
      category: "food",
      price: 15,
    });

    expect(await client.readMasterItems()).toEqual([
      { name: "นมสด UHT 250ml", category: "food" },
    ]);
    expect(await client.readPriceHistory()).toMatchObject([
      {
        date: "2026-08-04",
        store: "7-Eleven",
        masterItemName: "นมสด UHT 250ml",
        category: "food",
        price: 15,
        quantity: 1,
      },
    ]);
  });

  it("does not leak state between module loads", async () => {
    const first = await loadClient();
    await first.appendMasterItem("ขนมปัง", "food");
    expect(await first.readMasterItems()).toHaveLength(1);

    const second = await loadClient();
    expect(await second.readMasterItems()).toEqual([]);
  });

  it("never calls the Sheets API", async () => {
    // Mock mode exists so the app runs with no credentials at all; if it
    // reached the API it would throw on auth instead of working offline.
    const { google } = await import("googleapis");
    const spy = vi.spyOn(google, "sheets");

    const client = await loadClient();
    await client.appendMasterItem("มาม่า", "food");
    await client.readMasterItems();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("must-pay items in mock mode", () => {
  it("assigns an id and starts unpaid", async () => {
    const client = await loadClient();

    const item = await client.appendMustPayItem({
      name: "ค่าไฟ",
      amount: 1200,
      month: "2026-08",
    });

    expect(item.id).toBeTruthy();
    expect(item.status).toBe("unpaid");
    expect(item.paidAt).toBeNull();
  });

  it("gives each item a distinct id", async () => {
    const client = await loadClient();

    const a = await client.appendMustPayItem({ name: "ค่าไฟ", amount: 1, month: "2026-08" });
    const b = await client.appendMustPayItem({ name: "ค่าไฟ", amount: 1, month: "2026-08" });

    // Same name and amount every month -- the id is what mark-paid targets.
    expect(a.id).not.toBe(b.id);
  });

  it("marks an item paid and timestamps it", async () => {
    const client = await loadClient();
    const item = await client.appendMustPayItem({
      name: "ค่าน้ำ",
      amount: 300,
      month: "2026-08",
    });

    await client.updateMustPayStatus(item.id, "paid");

    const [stored] = await client.readMustPayItems();
    expect(stored.status).toBe("paid");
    expect(stored.paidAt).not.toBeNull();
  });

  it("ignores an unknown id rather than throwing", async () => {
    const client = await loadClient();

    await expect(client.updateMustPayStatus("no-such-id", "paid")).resolves.not.toThrow();
  });
});

describe("real mode row mapping", () => {
  /** Stub googleapis so we can assert on ranges and row parsing. */
  async function loadWithFakeSheets(rowsByRange: Record<string, unknown[][]>) {
    const calls: { get: string[]; append: { range: string; values: unknown[] }[] } = {
      get: [],
      append: [],
    };
    const { google } = await import("googleapis");
    vi.spyOn(google, "sheets").mockReturnValue({
      spreadsheets: {
        values: {
          get: async ({ range }: { range: string }) => {
            calls.get.push(range);
            return { data: { values: rowsByRange[range] ?? [] } };
          },
          append: async ({ range, requestBody }: any) => {
            calls.append.push({ range, values: requestBody.values[0] });
            return {};
          },
          update: async () => ({}),
        },
      },
    } as any);

    const client = await loadClient({
      SHEETS_MOCK_MODE: "false",
      SHEETS_SPREADSHEET_ID: "sheet-123",
    });
    return { client, calls };
  }

  it("skips the header row when reading", async () => {
    const { client, calls } = await loadWithFakeSheets({});

    await client.readMasterItems();

    // A2, not A1 -- starting at A1 would ingest the column headings as data.
    expect(calls.get[0]).toBe("MasterItems!A2:B");
  });

  it("parses master items and defaults an unknown category to food", async () => {
    const { client } = await loadWithFakeSheets({
      "MasterItems!A2:B": [
        ["นมสด", "food"],
        ["สบู่", "goods"],
        ["ของแปลก", "typo-category"],
      ],
    });

    expect(await client.readMasterItems()).toEqual([
      { name: "นมสด", category: "food" },
      { name: "สบู่", category: "goods" },
      { name: "ของแปลก", category: "food" },
    ]);
  });

  it("drops rows with no name", async () => {
    // Trailing blank rows are normal in a hand-edited sheet.
    const { client } = await loadWithFakeSheets({
      "MasterItems!A2:B": [["นมสด", "food"], ["", ""], [], ["สบู่", "goods"]],
    });

    expect(await client.readMasterItems()).toHaveLength(2);
  });

  it("reads a blank store as null rather than an empty string", async () => {
    const { client } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [["2026-08-04", "", "นมสด", "food", "15", "1", "id-1"]],
    });

    const [row] = await client.readPriceHistory();
    expect(row.store).toBeNull();
    expect(row.price).toBe(15); // sheet cells arrive as strings
  });

  it("writes a missing store as an empty cell", async () => {
    const { client, calls } = await loadWithFakeSheets({});

    await client.appendPriceHistoryRow({
      date: "2026-08-04",
      store: null,
      masterItemName: "นมสด",
      category: "food",
      price: 15,
    });

    const [date, store, name, category, price, quantity] = calls.append[0].values;
    expect([date, store, name, category, price, quantity]).toEqual([
      "2026-08-04",
      "",
      "นมสด",
      "food",
      15,
      1,
    ]);
  });

  it("parses must-pay rows including the paid timestamp", async () => {
    const { client } = await loadWithFakeSheets({
      "MustPay!A2:G": [
        ["id-1", "ค่าไฟ", "1200", "2026-08", "paid", "2026-08-04T10:00:00Z", ""],
        ["id-2", "ค่าน้ำ", "300", "2026-08", "unpaid", "", "recurring-key-1"],
      ],
    });

    expect(await client.readMustPayItems()).toEqual([
      {
        id: "id-1",
        name: "ค่าไฟ",
        amount: 1200,
        month: "2026-08",
        status: "paid",
        paidAt: "2026-08-04T10:00:00Z",
        recurringGroupKey: null,
      },
      {
        id: "id-2",
        name: "ค่าน้ำ",
        amount: 300,
        month: "2026-08",
        status: "unpaid",
        paidAt: null,
        recurringGroupKey: "recurring-key-1",
      },
    ]);
  });
});

describe("environment handling", () => {
  it("trims the spreadsheet id", async () => {
    // Dashboard paste picks up stray whitespace; an untrimmed id produced
    // an opaque failure in production once already.
    const { google } = await import("googleapis");
    let seenId = "";
    vi.spyOn(google, "sheets").mockReturnValue({
      spreadsheets: {
        values: {
          get: async ({ spreadsheetId }: { spreadsheetId: string }) => {
            seenId = spreadsheetId;
            return { data: { values: [] } };
          },
        },
      },
    } as any);

    const client = await loadClient({
      SHEETS_MOCK_MODE: "false",
      SHEETS_SPREADSHEET_ID: "  sheet-123\n",
    });
    await client.readMasterItems();

    expect(seenId).toBe("sheet-123");
  });

  it.each([
    ["unset", undefined],
    ["blank", ""],
    ["whitespace only", "   "],
  ])("stays in mock mode when the flag is %s", async (_label, value) => {
    // A variable created in a dashboard but left blank is not the same as
    // "false". `?? "true"` keeps the empty string, which read as "not
    // true" and pointed the app at the real Sheets API with no
    // credentials -- the failure mode is a 500 on every request.
    vi.resetModules();
    vi.stubEnv("SHEETS_MOCK_MODE", value as string);
    const { google } = await import("googleapis");
    const spy = vi.spyOn(google, "sheets");

    const client = await import("../src/sheets/client");
    await client.readMasterItems();

    expect(spy).not.toHaveBeenCalled();
  });

  it("still honours an explicit false", async () => {
    // The safety net above must not make it impossible to leave mock mode.
    const { google } = await import("googleapis");
    const spy = vi.spyOn(google, "sheets").mockReturnValue({
      spreadsheets: { values: { get: async () => ({ data: { values: [] } }) } },
    } as any);

    const client = await loadClient({ SHEETS_MOCK_MODE: "false" });
    await client.readMasterItems();

    expect(spy).toHaveBeenCalled();
  });
});

describe("cycles, income and settings", () => {
  /** Like the helper above, but also records `update` calls — the new tabs
   *  edit rows in place rather than only appending. */
  async function loadWithFakeSheets(rowsByRange: Record<string, unknown[][]>) {
    const calls: {
      append: { range: string; values: unknown[] }[];
      update: { range: string; values: unknown[] }[];
    } = { append: [], update: [] };
    const { google } = await import("googleapis");
    vi.spyOn(google, "sheets").mockReturnValue({
      spreadsheets: {
        values: {
          get: async ({ range }: { range: string }) => ({
            data: { values: rowsByRange[range] ?? [] },
          }),
          append: async ({ range, requestBody }: any) => {
            calls.append.push({ range, values: requestBody.values[0] });
            return {};
          },
          update: async ({ range, requestBody }: any) => {
            calls.update.push({ range, values: requestBody.values[0] });
            return {};
          },
        },
      },
    } as any);

    const client = await loadClient({
      SHEETS_MOCK_MODE: "false",
      SHEETS_SPREADSHEET_ID: "sheet-123",
    });
    return { client, calls };
  }

  it("reads a blank savings balance as null, not zero", async () => {
    // Blank means "haven't checked the bank yet"; zero would claim the
    // savings account is empty.
    const { client } = await loadWithFakeSheets({
      "Cycles!A2:C": [
        ["2026-08", "2026-07-25", ""],
        ["2026-09", "2026-08-27", "0"],
      ],
    });

    const rows = await client.readCycleRows();

    expect(rows[0].savingsBalance).toBeNull();
    expect(rows[1].savingsBalance).toBe(0);
  });

  it("parses a hand-typed thousands separator", async () => {
    // These tabs get edited directly in the Sheet, and "56,930.42" is the
    // natural thing to type. Number() would make that NaN and poison every
    // total it feeds.
    const { client } = await loadWithFakeSheets({
      "Cycles!A2:C": [["2026-08", "2026-07-25", "56,930.42"]],
      "PriceHistory!A2:H": [["2026-08-04", "Lotus's", "ข้าวสาร", "food", "1,250.50", "1", "id-1"]],
    });

    expect((await client.readCycleRows())[0].savingsBalance).toBe(56930.42);
    expect((await client.readPriceHistory())[0].price).toBe(1250.5);
  });

  it("appends a cycle row that doesn't exist yet", async () => {
    const { client, calls } = await loadWithFakeSheets({ "Cycles!A2:A": [] });

    await client.upsertCycleRow({ key: "2026-08", payday: "2026-07-25" });

    expect(calls.append[0]).toEqual({
      range: "Cycles!A:C",
      values: ["2026-08", "2026-07-25", ""],
    });
    expect(calls.update).toEqual([]);
  });

  it("updates the matching row instead of appending a duplicate", async () => {
    const { client, calls } = await loadWithFakeSheets({
      "Cycles!A2:A": [["2026-07"], ["2026-08"]],
      "Cycles!A2:C": [
        ["2026-07", "2026-06-25", ""],
        ["2026-08", "2026-07-25", ""],
      ],
    });

    await client.upsertCycleRow({ key: "2026-08", savingsBalance: 500 });

    // Second data row, and the header occupies row 1.
    expect(calls.update[0].range).toBe("Cycles!A3:C3");
    expect(calls.append).toEqual([]);
  });

  it("keeps the payday when only the savings balance changes", async () => {
    const { client, calls } = await loadWithFakeSheets({
      "Cycles!A2:A": [["2026-08"]],
      "Cycles!A2:C": [["2026-08", "2026-07-25", ""]],
    });

    await client.upsertCycleRow({ key: "2026-08", savingsBalance: 500 });

    expect(calls.update[0].values).toEqual(["2026-08", "2026-07-25", 500]);
  });

  it("blanks a deleted income row rather than leaving its data behind", async () => {
    const { client, calls } = await loadWithFakeSheets({
      "Income!A2:A": [["id-1"], ["id-2"]],
    });

    await client.deleteIncome("id-2");

    expect(calls.update[0]).toEqual({ range: "Income!A3:D3", values: ["", "", "", ""] });
  });

  it("skips blanked income rows when reading", async () => {
    const { client } = await loadWithFakeSheets({
      "Income!A2:D": [
        ["id-1", "2026-07-25", "เงินเดือน", "25000"],
        ["", "", "", ""],
      ],
    });

    expect(await client.readIncome()).toHaveLength(1);
  });

  it("treats a tab that doesn't exist yet as empty", async () => {
    // These three tabs came after the first Sheets went into use. The API
    // answers a missing tab with a 400, so without this a Sheet created
    // before them would 500 the Budget page — a page that works today.
    const { google } = await import("googleapis");
    vi.spyOn(google, "sheets").mockReturnValue({
      spreadsheets: {
        values: {
          get: async ({ range }: { range: string }) => {
            if (range.startsWith("Cycles")) throw new Error("Unable to parse range: Cycles!A2:C");
            return { data: { values: [] } };
          },
        },
      },
    } as any);
    const client = await loadClient({
      SHEETS_MOCK_MODE: "false",
      SHEETS_SPREADSHEET_ID: "sheet-123",
    });

    expect(await client.readCycleRows()).toEqual([]);
  });

  it("still surfaces a real Sheets failure", async () => {
    // Only a missing tab is tolerable. Swallowing auth or quota errors
    // would show the user an empty dashboard instead of a problem.
    const { google } = await import("googleapis");
    vi.spyOn(google, "sheets").mockReturnValue({
      spreadsheets: {
        values: {
          get: async () => {
            throw new Error("The caller does not have permission");
          },
        },
      },
    } as any);
    const client = await loadClient({
      SHEETS_MOCK_MODE: "false",
      SHEETS_SPREADSHEET_ID: "sheet-123",
    });

    await expect(client.readCycleRows()).rejects.toThrow(/does not have permission/);
  });

  it("reads a blank quantity as one, not zero", async () => {
    // Every row written before the Quantity column existed looks like
    // this. Zero would erase the line from every total that multiplies.
    const { client } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [["2026-08-04", "", "นมสด", "food", "15", "", ""]],
    });

    expect((await client.readPriceHistory())[0].quantity).toBe(1);
  });

  it("gives a row with no ID a handle based on its row number", async () => {
    // Pre-ID rows are the ones most likely to need correcting, so they
    // still have to be addressable.
    const { client } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [
        ["2026-08-01", "", "เก่า", "food", "10"],
        ["2026-08-02", "", "ใหม่", "food", "20", "1", "uuid-1"],
      ],
    });

    const rows = await client.readPriceHistory();
    expect(rows[0].id).toBe("row:2"); // header is row 1
    expect(rows[1].id).toBe("uuid-1");
  });

  it("numbers rows from the sheet, not from the filtered list", async () => {
    // A blanked row in the middle must not shift the handles after it.
    const { client } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [
        ["2026-08-01", "", "หนึ่ง", "food", "10"],
        [],
        ["2026-08-03", "", "สาม", "food", "30"],
      ],
    });

    expect((await client.readPriceHistory()).map((row) => row.id)).toEqual(["row:2", "row:4"]);
  });

  it("updates the row a UUID points at", async () => {
    const { client, calls } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [
        ["2026-08-01", "", "หนึ่ง", "food", "10", "1", "uuid-1"],
        ["2026-08-02", "", "สอง", "food", "20", "1", "uuid-2"],
      ],
      "PriceHistory!G2:G": [["uuid-1"], ["uuid-2"]],
    });

    await client.updatePriceHistoryRow("uuid-2", { price: 25 });

    expect(calls.update[0].range).toBe("PriceHistory!A3:H3");
    expect(calls.update[0].values).toEqual([
      "2026-08-02",
      "",
      "สอง",
      "food",
      25,
      1,
      "uuid-2",
      0,
    ]);
  });

  it("updates a pre-ID row without inventing an ID for it", async () => {
    // Writing a UUID here would invalidate the row: handle the caller is
    // still holding.
    const { client, calls } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [["2026-08-01", "", "เก่า", "food", "10"]],
    });

    await client.updatePriceHistoryRow("row:2", { quantity: 3 });

    expect(calls.update[0].range).toBe("PriceHistory!A2:H2");
    expect(calls.update[0].values).toEqual(["2026-08-01", "", "เก่า", "food", 10, 3, "", 0]);
  });

  it("blanks a deleted expense rather than removing the row", async () => {
    // Removing it would shift every later row number and break the
    // row: handles already handed out.
    const { client, calls } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [
        ["2026-08-01", "", "หนึ่ง", "food", "10", "1", "uuid-1"],
        ["2026-08-02", "", "สอง", "food", "20", "1", "uuid-2"],
      ],
      "PriceHistory!G2:G": [["uuid-1"], ["uuid-2"]],
    });

    expect(await client.deletePriceHistoryRow("uuid-2")).toBe(true);
    expect(calls.update[0]).toEqual({
      range: "PriceHistory!A3:H3",
      values: ["", "", "", "", "", "", "", ""],
    });
  });

  it("reports an unknown expense id rather than writing somewhere", async () => {
    const { client, calls } = await loadWithFakeSheets({ "PriceHistory!A2:H": [] });

    expect(await client.deletePriceHistoryRow("uuid-nope")).toBe(false);
    expect(await client.updatePriceHistoryRow("uuid-nope", { price: 1 })).toBeNull();
    expect(calls.update).toEqual([]);
  });

  it("reports a stale row handle rather than blanking an empty row", async () => {
    // "row:99" parses fine but points at nothing. Blanking it would
    // succeed silently and tell the user a row was deleted.
    const { client, calls } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [["2026-08-01", "", "เก่า", "food", "10"]],
    });

    expect(await client.deletePriceHistoryRow("row:99")).toBe(false);
    expect(calls.update).toEqual([]);
  });

  it("rejects a malformed row handle", async () => {
    // "row:1" is the header, and a non-numeric suffix is nonsense; either
    // would otherwise overwrite the column titles.
    const { client, calls } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [["2026-08-01", "", "เก่า", "food", "10"]],
    });

    expect(await client.deletePriceHistoryRow("row:1")).toBe(false);
    expect(await client.deletePriceHistoryRow("row:abc")).toBe(false);
    expect(calls.update).toEqual([]);
  });

  it("reads settings as a key/value map", async () => {
    const { client } = await loadWithFakeSheets({
      "Settings!A2:B": [
        ["opening_balance", "39643.61"],
        ["cycle_budget_food", "5000"],
      ],
    });

    expect(await client.readSettings()).toEqual({
      opening_balance: "39643.61",
      cycle_budget_food: "5000",
    });
  });

  it("overwrites an existing setting rather than adding a second row", async () => {
    const { client, calls } = await loadWithFakeSheets({
      "Settings!A2:A": [["opening_balance"]],
    });

    await client.writeSettings({ opening_balance: "1000", cycle_budget_food: "6000" });

    expect(calls.update[0]).toEqual({
      range: "Settings!A2:B2",
      values: ["opening_balance", "1000"],
    });
    expect(calls.append[0]).toEqual({
      range: "Settings!A:B",
      values: ["cycle_budget_food", "6000"],
    });
  });
});

describe("deleting a must-pay item", () => {
  async function loadWithFakeSheets(rowsByRange: Record<string, unknown[][]>) {
    const calls: { update: { range: string; values: unknown[] }[] } = { update: [] };
    const { google } = await import("googleapis");
    vi.spyOn(google, "sheets").mockReturnValue({
      spreadsheets: {
        values: {
          get: async ({ range }: { range: string }) => ({
            data: { values: rowsByRange[range] ?? [] },
          }),
          append: async () => ({}),
          update: async ({ range, requestBody }: any) => {
            calls.update.push({ range, values: requestBody.values[0] });
            return {};
          },
        },
      },
    } as any);

    const client = await loadClient({
      SHEETS_MOCK_MODE: "false",
      SHEETS_SPREADSHEET_ID: "sheet-123",
    });
    return { client, calls };
  }

  it("blanks the whole row so the read filter skips it", async () => {
    const { client, calls } = await loadWithFakeSheets({
      "MustPay!A2:A": [["id-1"], ["id-2"]],
    });

    expect(await client.deleteMustPayItem("id-2")).toBe(true);
    expect(calls.update[0]).toEqual({
      range: "MustPay!A3:G3",
      values: ["", "", "", "", "", "", ""],
    });
  });

  it("reports an unknown id rather than writing somewhere", async () => {
    const { client, calls } = await loadWithFakeSheets({ "MustPay!A2:A": [["id-1"]] });

    expect(await client.deleteMustPayItem("id-nope")).toBe(false);
    expect(calls.update).toEqual([]);
  });
});

describe("discounts", () => {
  async function loadWithFakeSheets(rowsByRange: Record<string, unknown[][]>) {
    const calls: { append: { range: string; values: unknown[] }[] } = { append: [] };
    const { google } = await import("googleapis");
    vi.spyOn(google, "sheets").mockReturnValue({
      spreadsheets: {
        values: {
          get: async ({ range }: { range: string }) => ({
            data: { values: rowsByRange[range] ?? [] },
          }),
          append: async ({ range, requestBody }: any) => {
            calls.append.push({ range, values: requestBody.values[0] });
            return {};
          },
          update: async () => ({}),
        },
      },
    } as any);
    const client = await loadClient({
      SHEETS_MOCK_MODE: "false",
      SHEETS_SPREADSHEET_ID: "sheet-123",
    });
    return { client, calls };
  }

  it("reads a blank discount as none", async () => {
    // Every row written before the column existed looks like this.
    const { client } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [["2026-08-04", "", "นมสด", "food", "15", "3", "id-1"]],
    });

    expect((await client.readPriceHistory())[0].discount).toBe(0);
  });

  it("subtracts the discount from what the line cost", async () => {
    const client = await loadClient();

    expect(client.lineTotal({ price: 15, quantity: 3, discount: 5 })).toBe(40);
  });

  it("leaves the unit price alone", async () => {
    // The whole point of storing them apart: the price history keeps the
    // printed price, so a promo doesn't become what the product costs.
    const { client } = await loadWithFakeSheets({
      "PriceHistory!A2:H": [["2026-08-04", "", "นมสด", "food", "15", "3", "id-1", "5"]],
    });

    const [row] = await client.readPriceHistory();
    expect(row.price).toBe(15);
    expect(row.discount).toBe(5);
    expect(client.lineTotal(row)).toBe(40);
  });

  it("writes the discount in its own column", async () => {
    const { client, calls } = await loadWithFakeSheets({});

    await client.appendPriceHistoryRow({
      date: "2026-08-04",
      store: null,
      masterItemName: "นมสด",
      category: "food",
      price: 15,
      quantity: 3,
      discount: 5,
    });

    expect(calls.append[0].range).toBe("PriceHistory!A:H");
    expect(calls.append[0].values[7]).toBe(5);
  });

  it("defaults a new row to no discount", async () => {
    const client = await loadClient();

    const row = await client.appendPriceHistoryRow({
      date: "2026-08-04",
      store: null,
      masterItemName: "นมสด",
      category: "food",
      price: 15,
    });

    expect(row.discount).toBe(0);
  });

  describe("isDiscountOnly", () => {
    it("recognises a bill-level discount row", async () => {
      // Stored as price 0 with a discount, so it totals to -50 without
      // needing a negative price anywhere.
      const client = await loadClient();

      expect(client.isDiscountOnly({ price: 0, discount: 50 })).toBe(true);
      expect(client.lineTotal({ price: 0, quantity: 1, discount: 50 })).toBe(-50);
    });

    it("does not mistake a free item for one", async () => {
      // Price 0 with no discount is a giveaway, and a real price point.
      const client = await loadClient();

      expect(client.isDiscountOnly({ price: 0, discount: 0 })).toBe(false);
    });

    it("does not mistake a discounted product for one", async () => {
      const client = await loadClient();

      expect(client.isDiscountOnly({ price: 15, discount: 5 })).toBe(false);
    });
  });
});
