/**
 * /budget reports today's spend against the daily caps and this month's
 * must-pay checklist. Both are date-filtered, so these tests pin "today"
 * rather than depending on when the suite runs.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TODAY = "2026-08-04";
const THIS_MONTH = "2026-08";

async function buildApp() {
  vi.resetModules();
  vi.stubEnv("SHEETS_MOCK_MODE", "true");

  const { budgetRouter } = await import("../src/routes/budget");
  const sheets = await import("../src/sheets/client");

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
  it("reports the daily caps from the spec", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/budget");

    expect(body.dailyBudget).toEqual({ food: 5000, goods: 5000 });
  });

  it("starts at zero spend with no history", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/budget");

    expect(body.spentToday).toEqual({ food: 0, goods: 0 });
  });

  it("totals today's spend per category", async () => {
    const { app, sheets } = await buildApp();
    for (const row of [
      { masterItemName: "นมสด", category: "food" as const, price: 15 },
      { masterItemName: "ขนมปัง", category: "food" as const, price: 29 },
      { masterItemName: "สบู่", category: "goods" as const, price: 59 },
    ]) {
      await sheets.appendPriceHistoryRow({ date: TODAY, store: "7-Eleven", ...row });
    }

    const { body } = await request(app).get("/budget");

    expect(body.spentToday).toEqual({ food: 44, goods: 59 });
  });

  it("ignores spend from other days", async () => {
    // The cap is per-day; counting yesterday would make it unusable.
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

    expect(body.spentToday.food).toBe(20);
  });

  it("returns only this month's must-pay items", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendMustPayItem({ name: "ค่าไฟ", amount: 1200, month: THIS_MONTH });
    await sheets.appendMustPayItem({ name: "ค่าไฟเดือนก่อน", amount: 900, month: "2026-07" });

    const { body } = await request(app).get("/budget");

    expect(body.mustPay).toHaveLength(1);
    expect(body.mustPay[0].name).toBe("ค่าไฟ");
  });
});

describe("POST /budget/must-pay", () => {
  it("creates an unpaid item for the current month", async () => {
    const { app } = await buildApp();

    const response = await request(app)
      .post("/budget/must-pay")
      .send({ name: "ค่าเน็ต", amount: 599 });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      name: "ค่าเน็ต",
      amount: 599,
      month: THIS_MONTH,
      status: "unpaid",
    });
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
      month: THIS_MONTH,
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
      month: THIS_MONTH,
    });
    await sheets.appendMustPayItem({ name: "ค่าน้ำ", amount: 300, month: THIS_MONTH });

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
    // The point is autocomplete for a bill that recurs monthly, so the
    // same name across months must collapse to one suggestion.
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
