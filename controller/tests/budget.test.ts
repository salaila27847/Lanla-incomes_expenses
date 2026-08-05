/**
 * /budget reports the current pay cycle's spend against its caps, plus
 * that cycle's must-pay checklist.
 *
 * It used to compare *today's* spend against 5,000 — a cap no single day at
 * this budget could reach, so the page never said anything. The caps are per
 * cycle, matching the user's own spreadsheet ("เป้าหมาย 5,000/เดือน" against
 * actuals of 4,000–6,000 a month).
 *
 * Both figures are cycle-filtered, so these tests pin "today" rather than
 * depending on when the suite runs.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TODAY = "2026-08-04";
// August's salary landed on 25 July, so the cycle running on TODAY is
// 25 Jul – 26 Aug and is keyed "2026-08".
const THIS_CYCLE = "2026-08";
const THIS_PAYDAY = "2026-07-25";

async function buildApp() {
  vi.resetModules();
  vi.stubEnv("SHEETS_MOCK_MODE", "true");

  const { budgetRouter } = await import("../src/routes/budget");
  const sheets = await import("../src/sheets/client");
  await sheets.upsertCycleRow({ key: THIS_CYCLE, payday: THIS_PAYDAY });
  await sheets.upsertCycleRow({ key: "2026-09", payday: "2026-08-27" });

  const app = express();
  app.use(express.json());
  app.use("/budget", budgetRouter);
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

describe("GET /budget", () => {
  it("reports the caps as per-cycle, defaulting to 5,000 each", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/budget");

    expect(body.cycleBudget).toEqual({ food: 5000, goods: 5000 });
  });

  it("reports the cycle the caps apply to", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/budget");

    expect(body.cycle).toMatchObject({ key: THIS_CYCLE, payday: THIS_PAYDAY, end: "2026-08-26" });
  });

  it("honours a cap the user changed", async () => {
    const { app, sheets } = await buildApp();
    await sheets.writeSettings({ cycle_budget_food: "6000" });

    const { body } = await request(app).get("/budget");

    expect(body.cycleBudget.food).toBe(6000);
  });

  it("starts at zero spend with no history", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/budget");

    expect(body.spentThisCycle).toEqual({ food: 0, goods: 0 });
  });

  it("totals the cycle's spend per category", async () => {
    const { app, sheets } = await buildApp();
    for (const row of [
      { masterItemName: "นมสด", category: "food" as const, price: 15 },
      { masterItemName: "ขนมปัง", category: "food" as const, price: 29 },
      { masterItemName: "สบู่", category: "goods" as const, price: 59 },
    ]) {
      await sheets.appendPriceHistoryRow({ date: TODAY, store: "7-Eleven", ...row });
    }

    const { body } = await request(app).get("/budget");

    expect(body.spentThisCycle).toEqual({ food: 44, goods: 59 });
  });

  it("counts earlier days in the same cycle", async () => {
    // The cap is per cycle now, so yesterday's lunch still counts against
    // it — the old daily version deliberately excluded this.
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow({
      date: "2026-08-03",
      store: null,
      masterItemName: "เมื่อวาน",
      category: "food",
      price: 500,
    });
    await sheets.appendPriceHistoryRow({
      date: TODAY,
      store: null,
      masterItemName: "วันนี้",
      category: "food",
      price: 20,
    });

    const { body } = await request(app).get("/budget");

    expect(body.spentThisCycle.food).toBe(520);
  });

  it("counts spend from before the calendar month but after payday", async () => {
    // 30 July is August's money. Grouping by calendar month would drop it.
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow({
      date: "2026-07-30",
      store: null,
      masterItemName: "ข้าวสาร",
      category: "food",
      price: 200,
    });

    const { body } = await request(app).get("/budget");

    expect(body.spentThisCycle.food).toBe(200);
  });

  it("ignores spend from the previous cycle", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow({
      date: "2026-07-20", // before 25 July, so it belongs to July's cycle
      store: null,
      masterItemName: "รอบก่อน",
      category: "food",
      price: 500,
    });

    const { body } = await request(app).get("/budget");

    expect(body.spentThisCycle.food).toBe(0);
  });

  it("returns only this cycle's must-pay items", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendMustPayItem({ name: "ค่าไฟ", amount: 1200, month: THIS_CYCLE });
    await sheets.appendMustPayItem({ name: "ค่าไฟรอบก่อน", amount: 900, month: "2026-07" });

    const { body } = await request(app).get("/budget");

    expect(body.mustPay).toHaveLength(1);
    expect(body.mustPay[0].name).toBe("ค่าไฟ");
  });
});

describe("POST /budget/must-pay", () => {
  it("creates an unpaid item stamped with the current cycle", async () => {
    const { app } = await buildApp();

    const response = await request(app)
      .post("/budget/must-pay")
      .send({ name: "ค่าเน็ต", amount: 599 });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      name: "ค่าเน็ต",
      amount: 599,
      month: THIS_CYCLE,
      status: "unpaid",
    });
  });

  it("stamps the funding cycle, not the calendar month", async () => {
    // Added on 30 July, days after August's salary landed: the bill is
    // August's, and filing it under July would hide it from the checklist.
    const { app } = await buildApp();
    vi.setSystemTime(new Date("2026-07-30T09:00:00Z"));

    const response = await request(app)
      .post("/budget/must-pay")
      .send({ name: "ค่าเน็ต", amount: 599 });

    expect(response.body.month).toBe("2026-08");
  });

  it.each([
    ["a missing name", { amount: 100 }],
    ["a blank name", { name: "", amount: 100 }],
    ["a zero amount", { name: "ค่าเน็ต", amount: 0 }],
    ["a negative amount", { name: "ค่าเน็ต", amount: -5 }],
    ["a non-numeric amount", { name: "ค่าเน็ต", amount: "599" }],
  ])("rejects %s", async (_label, payload) => {
    const { app, sheets } = await buildApp();

    const response = await request(app).post("/budget/must-pay").send(payload);

    expect(response.status).toBe(400);
    expect(await sheets.readMustPayItems()).toEqual([]);
  });
});

describe("POST /budget/must-pay/:id/mark-paid", () => {
  it("marks the item paid", async () => {
    const { app, sheets } = await buildApp();
    const item = await sheets.appendMustPayItem({
      name: "ค่าไฟ",
      amount: 1200,
      month: THIS_CYCLE,
    });

    const response = await request(app).post(`/budget/must-pay/${item.id}/mark-paid`);

    expect(response.status).toBe(200);
    expect((await sheets.readMustPayItems())[0].status).toBe("paid");
  });

  it("marks only the targeted item", async () => {
    const { app, sheets } = await buildApp();
    const first = await sheets.appendMustPayItem({
      name: "ค่าไฟ",
      amount: 1200,
      month: THIS_CYCLE,
    });
    await sheets.appendMustPayItem({ name: "ค่าน้ำ", amount: 300, month: THIS_CYCLE });

    await request(app).post(`/budget/must-pay/${first.id}/mark-paid`);

    const items = await sheets.readMustPayItems();
    expect(items.find((i) => i.id === first.id)!.status).toBe("paid");
    expect(items.find((i) => i.id !== first.id)!.status).toBe("unpaid");
  });
});

describe("GET /budget/must-pay/recurring-names", () => {
  it("is empty for a fresh install", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/budget/must-pay/recurring-names");

    expect(body.names).toEqual([]);
  });

  it("suggests each past bill once, at its most recent amount", async () => {
    // The point is autocomplete for a bill that recurs every cycle, so the
    // same name across cycles must collapse to one suggestion.
    const { app, sheets } = await buildApp();
    await sheets.appendMustPayItem({ name: "ค่าไฟ", amount: 900, month: "2026-06" });
    await sheets.appendMustPayItem({ name: "ค่าไฟ", amount: 1200, month: "2026-07" });
    await sheets.appendMustPayItem({ name: "ค่าน้ำ", amount: 300, month: "2026-07" });

    const { body } = await request(app).get("/budget/must-pay/recurring-names");

    expect(body.names).toEqual([
      { name: "ค่าไฟ", amount: 1200 },
      { name: "ค่าน้ำ", amount: 300 },
    ]);
  });
});
