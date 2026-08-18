/**
 * /income is the one thing the dashboard needs that receipt scanning can't
 * supply. Entries are stored with a date rather than a cycle key, so that
 * editing the payday calendar later re-buckets them instead of stranding
 * them in the wrong column.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function buildApp() {
  vi.resetModules();
  vi.stubEnv("SHEETS_MOCK_MODE", "true");

  const { incomeRouter } = await import("../src/routes/income");
  const sheets = await import("../src/sheets/client");

  const app = express();
  app.use(express.json());
  app.use("/income", incomeRouter);
  return { app, sheets };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /income", () => {
  it("stores an entry and returns it with an id", async () => {
    const { app } = await buildApp();

    const response = await request(app)
      .post("/income")
      .send({ date: "2026-07-25", source: "เงินเดือน", amount: 25811.42 });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      date: "2026-07-25",
      source: "เงินเดือน",
      amount: 25811.42,
    });
    expect(response.body.id).toBeTruthy();
  });

  it("trims the source name", async () => {
    const { app, sheets } = await buildApp();

    await request(app).post("/income").send({ date: "2026-07-25", source: "  โบนัส  ", amount: 500 });

    expect((await sheets.readIncome())[0].source).toBe("โบนัส");
  });

  it.each([
    ["a missing source", { date: "2026-07-25", amount: 100 }],
    ["a blank source", { date: "2026-07-25", source: "   ", amount: 100 }],
    ["a missing date", { source: "เงินเดือน", amount: 100 }],
    ["a malformed date", { date: "25/07/2026", source: "เงินเดือน", amount: 100 }],
    ["a zero amount", { date: "2026-07-25", source: "เงินเดือน", amount: 0 }],
    ["a negative amount", { date: "2026-07-25", source: "เงินเดือน", amount: -5 }],
    ["a string amount", { date: "2026-07-25", source: "เงินเดือน", amount: "500" }],
    ["an unrecognised destination_account", { date: "2026-07-25", source: "เงินเดือน", amount: 100, destination_account: "bank" }],
  ])("rejects %s", async (_label, payload) => {
    const { app, sheets } = await buildApp();

    const response = await request(app).post("/income").send(payload);

    expect(response.status).toBe(400);
    expect(await sheets.readIncome()).toEqual([]);
  });

  describe("destination_account", () => {
    it("defaults to spending and leaves no cycle's savings balance touched", async () => {
      const { app, sheets } = await buildApp();

      const response = await request(app)
        .post("/income")
        .send({ date: "2026-07-25", source: "เงินเดือน", amount: 25000 });

      expect(response.body.destinationAccount).toBe("spending");
      expect(await sheets.readCycleRows()).toEqual([]);
    });

    it("rolls a savings-tagged deposit into that date's cycle balance", async () => {
      // 25 Jul with no custom paydays configured opens the "2026-08" cycle
      // (day 25 > 15, so the estimated payday day 25 rolls it forward) --
      // same cycle key budget.test.ts pins for the same date.
      const { app, sheets } = await buildApp();

      const response = await request(app)
        .post("/income")
        .send({ date: "2026-07-25", source: "โบนัส", amount: 5000, destination_account: "savings" });

      expect(response.body.destinationAccount).toBe("savings");
      const [cycle] = await sheets.readCycleRows();
      expect(cycle).toMatchObject({ key: "2026-08", savingsBalance: 5000 });
    });

    it("adds to an already-recorded balance rather than overwriting it", async () => {
      const { app, sheets } = await buildApp();
      await sheets.upsertCycleRow({ key: "2026-08", savingsBalance: 12000 });

      await request(app)
        .post("/income")
        .send({ date: "2026-07-25", source: "โบนัส", amount: 5000, destination_account: "savings" });

      const [cycle] = await sheets.readCycleRows();
      expect(cycle).toMatchObject({ savingsBalance: 17000 });
    });

    it("does not disturb the payday already on record for that cycle", async () => {
      const { app, sheets } = await buildApp();
      await sheets.upsertCycleRow({ key: "2026-08", payday: "2026-07-23" });

      await request(app)
        .post("/income")
        .send({ date: "2026-07-25", source: "โบนัส", amount: 5000, destination_account: "savings" });

      const [cycle] = await sheets.readCycleRows();
      expect(cycle).toMatchObject({ payday: "2026-07-23", savingsBalance: 5000 });
    });
  });
});

describe("GET /income", () => {
  it("is empty for a fresh install", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/income");

    expect(body.entries).toEqual([]);
  });

  it("returns newest first", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendIncome({ date: "2026-06-25", source: "เงินเดือน", amount: 1 });
    await sheets.appendIncome({ date: "2026-08-25", source: "เงินเดือน", amount: 3 });
    await sheets.appendIncome({ date: "2026-07-25", source: "เงินเดือน", amount: 2 });

    const { body } = await request(app).get("/income");

    expect(body.entries.map((entry: any) => entry.amount)).toEqual([3, 2, 1]);
  });

  it("filters by year when asked", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendIncome({ date: "2025-12-25", source: "เงินเดือน", amount: 100 });
    await sheets.appendIncome({ date: "2026-01-25", source: "เงินเดือน", amount: 200 });

    const { body } = await request(app).get("/income?year=2026");

    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].amount).toBe(200);
  });

  it("filters by cycle when asked, and returns the cycle's own bounds", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendIncome({ date: "2026-06-25", source: "เงินเดือน", amount: 1 }); // 2026-07 cycle
    await sheets.appendIncome({ date: "2026-07-25", source: "เงินเดือน", amount: 2 }); // 2026-08 cycle

    const { body } = await request(app).get("/income?cycle=2026-08");

    expect(body.cycle).toMatchObject({ key: "2026-08" });
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].amount).toBe(2);
  });

  it("rejects a malformed cycle key", async () => {
    const { app } = await buildApp();

    const response = await request(app).get("/income?cycle=not-a-cycle");

    expect(response.status).toBe(400);
  });
});

describe("GET /income/sources", () => {
  it("suggests each source once, at its most recent amount", async () => {
    // Same autocomplete idea as recurring must-pay names: a salary that
    // recurs every cycle must collapse to one suggestion.
    const { app, sheets } = await buildApp();
    await sheets.appendIncome({ date: "2026-06-25", source: "เงินเดือน", amount: 25000 });
    await sheets.appendIncome({ date: "2026-07-25", source: "เงินเดือน", amount: 25811 });
    await sheets.appendIncome({ date: "2026-07-25", source: "ขายของ", amount: 1500 });

    const { body } = await request(app).get("/income/sources");

    expect(body.sources).toEqual([
      { source: "เงินเดือน", amount: 25811 },
      { source: "ขายของ", amount: 1500 },
    ]);
  });

  it("takes the latest by date, not by insertion order", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendIncome({ date: "2026-07-25", source: "เงินเดือน", amount: 25811 });
    await sheets.appendIncome({ date: "2026-06-25", source: "เงินเดือน", amount: 25000 });

    const { body } = await request(app).get("/income/sources");

    expect(body.sources[0].amount).toBe(25811);
  });
});

describe("DELETE /income/:id", () => {
  it("removes only the targeted entry", async () => {
    const { app, sheets } = await buildApp();
    const first = await sheets.appendIncome({
      date: "2026-07-25",
      source: "เงินเดือน",
      amount: 25000,
    });
    await sheets.appendIncome({ date: "2026-07-25", source: "ขายของ", amount: 1500 });

    await request(app).delete(`/income/${first.id}`);

    const remaining = await sheets.readIncome();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].source).toBe("ขายของ");
  });

  it("is a no-op for an unknown id", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendIncome({ date: "2026-07-25", source: "เงินเดือน", amount: 25000 });

    const response = await request(app).delete("/income/does-not-exist");

    expect(response.status).toBe(200);
    expect(await sheets.readIncome()).toHaveLength(1);
  });
});
