/**
 * /dashboard renders a year as pay-cycle columns.
 *
 * The two things most worth pinning here are the ones a plain
 * group-by-month would get wrong: spend after payday belongs to the *next*
 * month's column, and the account balance is a running total that has to
 * carry across a year boundary rather than restarting each January.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TODAY = "2026-08-04";

// Two consecutive cycles from the user's real spreadsheet: August's salary
// landed 25 July, September's on 27 August.
const AUGUST = { key: "2026-08", payday: "2026-07-25" };
const SEPTEMBER = { key: "2026-09", payday: "2026-08-27" };

async function buildApp() {
  vi.resetModules();
  vi.stubEnv("SHEETS_MOCK_MODE", "true");

  const { dashboardRouter } = await import("../src/routes/dashboard");
  const sheets = await import("../src/sheets/client");

  const app = express();
  app.use(express.json());
  app.use("/dashboard", dashboardRouter);
  return { app, sheets };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T09:00:00Z`));
});

afterEach(() => {
  vi.useRealTimers();
});

function amountsOf(body: any, sectionId: string, rowName: string) {
  const section = body.sections.find((s: any) => s.id === sectionId);
  return section.rows.find((r: any) => r.name === rowName)?.amounts;
}

describe("GET /dashboard", () => {
  it("returns twelve cycle columns for the requested year", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(body.year).toBe(2026);
    expect(body.cycles).toHaveLength(12);
    expect(body.cycles[0].key).toBe("2026-01");
    expect(body.cycles[11].key).toBe("2026-12");
  });

  it("uses the paydays the user recorded", async () => {
    const { app, sheets } = await buildApp();
    await sheets.upsertCycleRow(AUGUST);

    const { body } = await request(app).get("/dashboard?year=2026");
    const august = body.cycles.find((c: any) => c.key === "2026-08");

    expect(august.payday).toBe("2026-07-25");
  });

  it("marks the cycle today falls in", async () => {
    const { app, sheets } = await buildApp();
    await sheets.upsertCycleRow(AUGUST);
    await sheets.upsertCycleRow(SEPTEMBER);

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(body.currentCycleKey).toBe("2026-08");
  });

  it("defaults to the current year when none is given", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/dashboard");

    expect(body.year).toBe(2026);
  });

  it("groups income by source", async () => {
    const { app, sheets } = await buildApp();
    await sheets.upsertCycleRow(AUGUST);
    await sheets.appendIncome({ date: "2026-07-25", source: "เงินเดือน", amount: 25000 });
    await sheets.appendIncome({ date: "2026-08-10", source: "เงินเดือน", amount: 3000 });
    await sheets.appendIncome({ date: "2026-08-10", source: "ขายของ", amount: 1500 });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(amountsOf(body, "income", "เงินเดือน")["2026-08"]).toBe(28000);
    expect(amountsOf(body, "income", "ขายของ")["2026-08"]).toBe(1500);
    expect(body.totals.income["2026-08"]).toBe(29500);
  });

  it("groups fixed expenses by bill name", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendMustPayItem({ name: "ค่าบ้าน", amount: 7000, month: "2026-08" });
    await sheets.appendMustPayItem({ name: "ค่าไฟ", amount: 1269.69, month: "2026-08" });
    await sheets.appendMustPayItem({ name: "ค่าบ้าน", amount: 7000, month: "2026-09" });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(amountsOf(body, "fixed", "ค่าบ้าน")).toMatchObject({
      "2026-08": 7000,
      "2026-09": 7000,
    });
    expect(amountsOf(body, "fixed", "ค่าไฟ")["2026-08"]).toBe(1269.69);
  });

  it("counts unpaid bills too", async () => {
    // They're committed money; a balance that ignores them reads higher
    // than what's actually spendable.
    const { app, sheets } = await buildApp();
    await sheets.appendMustPayItem({ name: "ค่าเน็ต", amount: 599, month: "2026-08" });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(body.totals.expense["2026-08"]).toBe(599);
  });

  it("splits receipt spend into food and goods", async () => {
    const { app, sheets } = await buildApp();
    await sheets.upsertCycleRow(AUGUST);
    await sheets.appendPriceHistoryRow({
      date: "2026-08-01",
      store: "Lotus's",
      masterItemName: "หมูสับ",
      category: "food",
      price: 120,
    });
    await sheets.appendPriceHistoryRow({
      date: "2026-08-01",
      store: "Lotus's",
      masterItemName: "ผงซักฟอก",
      category: "goods",
      price: 89,
    });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(amountsOf(body, "variable", "🍔 ค่ากิน")["2026-08"]).toBe(120);
    expect(amountsOf(body, "variable", "🧴 ของใช้")["2026-08"]).toBe(89);
  });

  it("puts spend after payday in the next month's column", async () => {
    // The whole reason cycles exist. 30 July is August's money, because
    // August's salary landed on 25 July — a calendar-month grouping would
    // file it under July.
    const { app, sheets } = await buildApp();
    await sheets.upsertCycleRow(AUGUST);
    await sheets.appendPriceHistoryRow({
      date: "2026-07-30",
      store: null,
      masterItemName: "ข้าวสาร",
      category: "food",
      price: 200,
    });

    const { body } = await request(app).get("/dashboard?year=2026");
    const food = amountsOf(body, "variable", "🍔 ค่ากิน");

    expect(food["2026-08"]).toBe(200);
    expect(food["2026-07"]).toBe(0);
  });

  it("hides rows with nothing in the displayed year", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendMustPayItem({ name: "ผ่อนเก่า", amount: 500, month: "2024-03" });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(amountsOf(body, "fixed", "ผ่อนเก่า")).toBeUndefined();
  });
});

describe("GET /dashboard totals", () => {
  it("sums fixed and variable spend into one expense figure", async () => {
    const { app, sheets } = await buildApp();
    await sheets.upsertCycleRow(AUGUST);
    await sheets.appendMustPayItem({ name: "ค่าบ้าน", amount: 7000, month: "2026-08" });
    await sheets.appendPriceHistoryRow({
      date: "2026-08-01",
      store: null,
      masterItemName: "หมูสับ",
      category: "food",
      price: 120,
    });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(body.totals.expense["2026-08"]).toBe(7120);
  });

  it("nets income against expenses", async () => {
    const { app, sheets } = await buildApp();
    await sheets.upsertCycleRow(AUGUST);
    await sheets.appendIncome({ date: "2026-08-01", source: "เงินเดือน", amount: 25000 });
    await sheets.appendMustPayItem({ name: "ค่าบ้าน", amount: 7000, month: "2026-08" });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(body.totals.net["2026-08"]).toBe(18000);
  });

  it("runs the spending balance forward from the opening balance", async () => {
    const { app, sheets } = await buildApp();
    await sheets.writeSettings({ opening_balance: "1000" });
    await sheets.upsertCycleRow(AUGUST);
    await sheets.upsertCycleRow(SEPTEMBER);
    await sheets.appendIncome({ date: "2026-08-01", source: "เงินเดือน", amount: 5000 });
    await sheets.appendMustPayItem({ name: "ค่าบ้าน", amount: 2000, month: "2026-08" });
    await sheets.appendMustPayItem({ name: "ค่าบ้าน", amount: 2000, month: "2026-09" });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(body.totals.spendingBalance["2026-08"]).toBe(4000); // 1000 + 5000 − 2000
    expect(body.totals.spendingBalance["2026-09"]).toBe(2000); // carries, then − 2000
  });

  it("carries the balance in from earlier years", async () => {
    // Without this the balance restarts from the opening figure every
    // January and every column of the year is wrong.
    const { app, sheets } = await buildApp();
    await sheets.writeSettings({ opening_balance: "1000" });
    await sheets.appendIncome({ date: "2025-06-20", source: "เงินเดือน", amount: 10000 });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(body.totals.spendingBalance["2026-01"]).toBe(11000);
  });

  it("reports the savings balance the user entered, and null where they haven't", async () => {
    // Savings can't be derived: money sometimes leaves that account
    // directly, which is what the QR transfer-back flow exists to reverse.
    const { app, sheets } = await buildApp();
    await sheets.upsertCycleRow({ ...AUGUST, savingsBalance: 56930.42 });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(body.totals.savingsBalance["2026-08"]).toBe(56930.42);
    expect(body.totals.savingsBalance["2026-09"]).toBeNull();
  });

  it("keeps a savings balance of zero distinct from not entered", async () => {
    const { app, sheets } = await buildApp();
    await sheets.upsertCycleRow({ ...AUGUST, savingsBalance: 0 });

    const { body } = await request(app).get("/dashboard?year=2026");

    expect(body.totals.savingsBalance["2026-08"]).toBe(0);
  });
});

describe("/dashboard/settings", () => {
  it("defaults the caps to 5,000 per cycle and the opening balance to zero", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/dashboard/settings");

    expect(body).toEqual({
      openingBalance: 0,
      cycleBudgetFood: 5000,
      cycleBudgetGoods: 5000,
    });
  });

  it("saves and reads back a changed cap", async () => {
    const { app } = await buildApp();

    await request(app).put("/dashboard/settings").send({ cycleBudgetFood: 6000 });
    const { body } = await request(app).get("/dashboard/settings");

    expect(body.cycleBudgetFood).toBe(6000);
    expect(body.cycleBudgetGoods).toBe(5000); // untouched
  });

  it("rejects a non-numeric value", async () => {
    const { app } = await buildApp();

    const response = await request(app).put("/dashboard/settings").send({ openingBalance: "abc" });

    expect(response.status).toBe(400);
  });
});

describe("/dashboard/cycles", () => {
  it("flags which paydays are assumed rather than entered", async () => {
    const { app, sheets } = await buildApp();
    await sheets.upsertCycleRow(AUGUST);

    const { body } = await request(app).get("/dashboard/cycles?year=2026");
    const byKey = Object.fromEntries(body.cycles.map((c: any) => [c.key, c]));

    expect(byKey["2026-08"].paydayIsRecorded).toBe(true);
    expect(byKey["2026-09"].paydayIsRecorded).toBe(false);
  });

  it("stores a payday and a savings balance", async () => {
    const { app } = await buildApp();

    const response = await request(app)
      .put("/dashboard/cycles/2026-08")
      .send({ payday: "2026-07-25", savingsBalance: 56930.42 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      key: "2026-08",
      payday: "2026-07-25",
      savingsBalance: 56930.42,
    });
  });

  it("keeps the payday when only the balance is updated", async () => {
    const { app } = await buildApp();
    await request(app).put("/dashboard/cycles/2026-08").send({ payday: "2026-07-25" });

    const response = await request(app)
      .put("/dashboard/cycles/2026-08")
      .send({ savingsBalance: 100 });

    expect(response.body.payday).toBe("2026-07-25");
  });

  it("rejects a payday that belongs to a different cycle", async () => {
    // 2026-08-27 opens September's cycle. Accepting it here would give two
    // cycles the same key and silently merge their columns.
    const { app } = await buildApp();

    const response = await request(app)
      .put("/dashboard/cycles/2026-08")
      .send({ payday: "2026-08-27" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("2026-09");
  });

  it.each([
    ["a malformed cycle key", "/dashboard/cycles/2026-8", { payday: "2026-07-25" }],
    ["a malformed date", "/dashboard/cycles/2026-08", { payday: "25/07/2026" }],
    ["a non-numeric balance", "/dashboard/cycles/2026-08", { savingsBalance: "abc" }],
  ])("rejects %s", async (_label, url, payload) => {
    const { app } = await buildApp();

    const response = await request(app).put(url).send(payload);

    expect(response.status).toBe(400);
  });
});
