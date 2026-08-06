/**
 * /expenses is direct access to the PriceHistory rows a receipt scan
 * writes. Scanning used to be the only way to create one, so a misread
 * line was permanent — nothing could be added, corrected or removed.
 *
 * The rows are cycle-filtered, so "today" is pinned rather than observed.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TODAY = "2026-08-04";
const THIS_CYCLE = "2026-08";

async function buildApp() {
  vi.resetModules();
  vi.stubEnv("SHEETS_MOCK_MODE", "true");

  const { expensesRouter } = await import("../src/routes/expenses");
  const sheets = await import("../src/sheets/client");
  await sheets.upsertCycleRow({ key: THIS_CYCLE, payday: "2026-07-25" });
  await sheets.upsertCycleRow({ key: "2026-09", payday: "2026-08-27" });

  const app = express();
  app.use(express.json());
  app.use("/expenses", expensesRouter);
  return { app, sheets };
}

const VALID = {
  date: TODAY,
  store: "Lotus's",
  masterItemName: "นมสด UHT 250ml",
  category: "food",
  price: 15,
  quantity: 3,
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T09:00:00Z`));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /expenses", () => {
  it("stores a row and returns it with an id", async () => {
    const { app } = await buildApp();

    const response = await request(app).post("/expenses").send(VALID);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ masterItemName: "นมสด UHT 250ml", price: 15, quantity: 3 });
    expect(response.body.id).toBeTruthy();
  });

  it("defaults quantity to one", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).post("/expenses").send({ ...VALID, quantity: undefined });

    expect(body.quantity).toBe(1);
  });

  it("creates the master item when the name is new", async () => {
    // Otherwise a name typed here never becomes pickable anywhere else.
    const { app, sheets } = await buildApp();

    await request(app).post("/expenses").send(VALID);

    expect(await sheets.readMasterItems()).toEqual([
      { name: "นมสด UHT 250ml", category: "food" },
    ]);
  });

  it("does not duplicate an existing master item", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendMasterItem("นมสด UHT 250ml", "food");

    await request(app).post("/expenses").send(VALID);

    expect(await sheets.readMasterItems()).toHaveLength(1);
  });

  it("trims the item name and treats a blank store as none", async () => {
    const { app } = await buildApp();

    const { body } = await request(app)
      .post("/expenses")
      .send({ ...VALID, masterItemName: "  นมสด  ", store: "   " });

    expect(body.masterItemName).toBe("นมสด");
    expect(body.store).toBeNull();
  });

  it("accepts a price of zero", async () => {
    // A freebie or a fully discounted line is still a line.
    const { app } = await buildApp();

    const response = await request(app).post("/expenses").send({ ...VALID, price: 0 });

    expect(response.status).toBe(201);
  });

  it.each([
    ["a missing date", { date: undefined }],
    ["a malformed date", { date: "04/08/2026" }],
    ["a missing item name", { masterItemName: undefined }],
    ["a blank item name", { masterItemName: "   " }],
    ["an unknown category", { category: "rent" }],
    ["a missing category", { category: undefined }],
    ["a negative price", { price: -1 }],
    ["a non-numeric price", { price: "ถูกมาก" }],
    ["a zero quantity", { quantity: 0 }],
    ["a fractional quantity", { quantity: 1.5 }],
    ["a negative quantity", { quantity: -2 }],
  ])("rejects %s", async (_label, patch) => {
    const { app, sheets } = await buildApp();

    const response = await request(app).post("/expenses").send({ ...VALID, ...patch });

    expect(response.status).toBe(400);
    expect(await sheets.readPriceHistory()).toEqual([]);
  });
});

describe("GET /expenses", () => {
  it("is empty for a fresh install", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/expenses");

    expect(body.expenses).toEqual([]);
  });

  it("returns newest first", async () => {
    const { app, sheets } = await buildApp();
    for (const date of ["2026-08-01", "2026-08-03", "2026-08-02"]) {
      await sheets.appendPriceHistoryRow({ ...VALID, date, category: "food" });
    }

    const { body } = await request(app).get("/expenses");

    expect(body.expenses.map((e: any) => e.date)).toEqual([
      "2026-08-03",
      "2026-08-02",
      "2026-08-01",
    ]);
  });

  it("filters to one pay cycle, not one calendar month", async () => {
    // 30 July is August's money: August's salary landed on 25 July.
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow({ ...VALID, date: "2026-07-30", category: "food" });
    await sheets.appendPriceHistoryRow({ ...VALID, date: "2026-07-20", category: "food" });

    const { body } = await request(app).get(`/expenses?cycle=${THIS_CYCLE}`);

    expect(body.expenses).toHaveLength(1);
    expect(body.expenses[0].date).toBe("2026-07-30");
    expect(body.cycle).toMatchObject({ key: THIS_CYCLE, payday: "2026-07-25" });
  });

  it("rejects a malformed cycle key", async () => {
    const { app } = await buildApp();

    expect((await request(app).get("/expenses?cycle=2026-8")).status).toBe(400);
  });
});

describe("PUT /expenses/:id", () => {
  it("changes only the fields sent", async () => {
    const { app, sheets } = await buildApp();
    const row = await sheets.appendPriceHistoryRow({ ...VALID, category: "food" });

    const response = await request(app).put(`/expenses/${row.id}`).send({ price: 16.5 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      price: 16.5,
      quantity: 3, // untouched
      masterItemName: "นมสด UHT 250ml",
      date: TODAY,
    });
  });

  it("persists the change", async () => {
    const { app, sheets } = await buildApp();
    const row = await sheets.appendPriceHistoryRow({ ...VALID, category: "food" });

    await request(app).put(`/expenses/${row.id}`).send({ quantity: 1 });

    expect((await sheets.readPriceHistory())[0].quantity).toBe(1);
  });

  it("can move a line to the other category", async () => {
    const { app, sheets } = await buildApp();
    const row = await sheets.appendPriceHistoryRow({ ...VALID, category: "food" });

    await request(app).put(`/expenses/${row.id}`).send({ category: "goods" });

    expect((await sheets.readPriceHistory())[0].category).toBe("goods");
  });

  it("404s for an unknown id", async () => {
    const { app } = await buildApp();

    expect((await request(app).put("/expenses/nope").send({ price: 1 })).status).toBe(404);
  });

  it.each([
    ["a malformed date", { date: "04/08/2026" }],
    ["a blank item name", { masterItemName: "  " }],
    ["a zero quantity", { quantity: 0 }],
    ["a negative price", { price: -1 }],
  ])("rejects %s without touching the row", async (_label, patch) => {
    const { app, sheets } = await buildApp();
    const row = await sheets.appendPriceHistoryRow({ ...VALID, category: "food" });

    const response = await request(app).put(`/expenses/${row.id}`).send(patch);

    expect(response.status).toBe(400);
    expect((await sheets.readPriceHistory())[0]).toEqual(row);
  });
});

describe("DELETE /expenses/:id", () => {
  it("removes only the targeted row", async () => {
    const { app, sheets } = await buildApp();
    const first = await sheets.appendPriceHistoryRow({ ...VALID, category: "food" });
    await sheets.appendPriceHistoryRow({ ...VALID, masterItemName: "สบู่", category: "goods" });

    const response = await request(app).delete(`/expenses/${first.id}`);

    expect(response.status).toBe(200);
    const remaining = await sheets.readPriceHistory();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].masterItemName).toBe("สบู่");
  });

  it("404s for an unknown id", async () => {
    const { app } = await buildApp();

    expect((await request(app).delete("/expenses/nope")).status).toBe(404);
  });
});
