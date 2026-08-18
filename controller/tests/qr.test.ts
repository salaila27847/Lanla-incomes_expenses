/**
 * /qr is a thin proxy to the Python backend. The reason it exists at all
 * is that the destination PromptPay ID is a backend-only secret: the PWA
 * sends an amount and nothing else, so this route must never accept or
 * forward a caller-supplied account.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BACKEND = "http://backend.test";

async function buildApp() {
  vi.resetModules();
  vi.stubEnv("PYTHON_BACKEND_URL", BACKEND);

  const { qrRouter } = await import("../src/routes/qr");
  const app = express();
  app.use(express.json());
  app.use("/qr", qrRouter);
  return app;
}

function stubBackend(status = 200, body: unknown = { payload: "0002...", qr_data_url: "data:," }) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /qr", () => {
  it("forwards the amount to the backend and returns its response", async () => {
    const app = await buildApp();
    const calls = stubBackend(200, { payload: "00020101021229...", qr_data_url: "data:image/png;base64,AAA" });

    const response = await request(app).post("/qr").send({ amount_thb: 500 });

    expect(response.status).toBe(200);
    expect(response.body.qr_data_url).toBe("data:image/png;base64,AAA");
    expect(calls[0].url).toBe(`${BACKEND}/qr/`);
    expect(calls[0].body).toEqual({ amount_thb: 500 });
  });

  it("never forwards a caller-supplied PromptPay id", async () => {
    // Honouring this would let anyone with the app URL generate a QR
    // pointing at an account of their choosing.
    const app = await buildApp();
    const calls = stubBackend();

    await request(app).post("/qr").send({ amount_thb: 500, promptpay_id: "0000000000" });

    expect(calls[0].body).toEqual({ amount_thb: 500 });
    expect(calls[0].body).not.toHaveProperty("promptpay_id");
  });

  it("passes a backend error status straight through", async () => {
    const app = await buildApp();
    stubBackend(400, { detail: "No PromptPay ID configured" });

    const response = await request(app).post("/qr").send({ amount_thb: 500 });

    expect(response.status).toBe(400);
    expect(response.body.detail).toBe("No PromptPay ID configured");
  });

  it.each([
    ["a zero amount", { amount_thb: 0 }],
    ["a negative amount", { amount_thb: -1 }],
    ["a missing amount", {}],
    ["a string amount", { amount_thb: "500" }],
  ])("rejects %s without calling the backend", async (_label, payload) => {
    const app = await buildApp();
    const calls = stubBackend();

    const response = await request(app).post("/qr").send(payload);

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

/**
 * A line paid straight from the savings account isn't a recorded expense
 * yet — /receipt/confirm holds it here instead of writing PriceHistory.
 * These routes are how it either becomes a real expense (once the
 * transfer-back QR has actually been sent) or gets cancelled outright.
 */
describe("/qr/pending", () => {
  async function buildAppWithSheets() {
    vi.resetModules();
    vi.stubEnv("SHEETS_MOCK_MODE", "true");
    vi.stubEnv("PYTHON_BACKEND_URL", BACKEND);

    const { qrRouter } = await import("../src/routes/qr");
    const sheets = await import("../src/sheets/client");

    const app = express();
    app.use(express.json());
    app.use("/qr", qrRouter);
    return { app, sheets };
  }

  it("lists what's waiting to be transferred", async () => {
    const { app, sheets } = await buildAppWithSheets();
    await sheets.appendPendingSavingsItem({
      date: "2026-08-04",
      store: "7-Eleven",
      masterItemName: "นมสด UHT 250ml",
      category: "food",
      price: 15,
      quantity: 1,
      discount: 0,
    });

    const response = await request(app).get("/qr/pending");

    expect(response.status).toBe(200);
    expect(response.body.items).toMatchObject([{ masterItemName: "นมสด UHT 250ml" }]);
  });

  it("moves a confirmed item into PriceHistory using its original purchase date", async () => {
    // Confirming can happen days after the purchase — it must not jump
    // the item into whatever cycle "today" falls in.
    const { app, sheets } = await buildAppWithSheets();
    const pending = await sheets.appendPendingSavingsItem({
      date: "2026-07-28",
      store: "Big C",
      masterItemName: "ผงซักฟอก",
      category: "goods",
      price: 120,
      quantity: 1,
      discount: 0,
    });

    const response = await request(app).post(`/qr/pending/${pending.id}/confirm`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, id: pending.id });
    expect(await sheets.readPendingSavingsItems()).toHaveLength(0);
    expect(await sheets.readPriceHistory()).toMatchObject([
      { date: "2026-07-28", store: "Big C", masterItemName: "ผงซักฟอก", price: 120 },
    ]);
  });

  it("creates the master item on confirm if it's new", async () => {
    const { app, sheets } = await buildAppWithSheets();
    const pending = await sheets.appendPendingSavingsItem({
      date: "2026-07-28",
      store: null,
      masterItemName: "ผงซักฟอก",
      category: "goods",
      price: 120,
      quantity: 1,
      discount: 0,
    });

    await request(app).post(`/qr/pending/${pending.id}/confirm`);

    expect(await sheets.readMasterItems()).toMatchObject([{ name: "ผงซักฟอก", category: "goods" }]);
  });

  it("404s confirming an id that doesn't exist", async () => {
    const { app } = await buildAppWithSheets();

    const response = await request(app).post("/qr/pending/does-not-exist/confirm");

    expect(response.status).toBe(404);
  });

  it("deletes a pending item without writing it anywhere", async () => {
    const { app, sheets } = await buildAppWithSheets();
    const pending = await sheets.appendPendingSavingsItem({
      date: "2026-08-04",
      store: null,
      masterItemName: "นมสด UHT 250ml",
      category: "food",
      price: 15,
      quantity: 1,
      discount: 0,
    });

    const response = await request(app).delete(`/qr/pending/${pending.id}`);

    expect(response.status).toBe(200);
    expect(await sheets.readPendingSavingsItems()).toHaveLength(0);
    expect(await sheets.readPriceHistory()).toHaveLength(0);
  });

  it("404s deleting an id that doesn't exist", async () => {
    const { app } = await buildAppWithSheets();

    const response = await request(app).delete("/qr/pending/does-not-exist");

    expect(response.status).toBe(404);
  });
});

/**
 * The other settlement path for a pending item: the savings account keeps
 * the cost permanently (a big item actually saved up for) instead of being
 * reimbursed by the spending account. Still becomes a normal PriceHistory
 * row -- price history doesn't care which account paid -- but unlike
 * /confirm, it also logs a SavingsWithdrawal and lowers the cycle's own
 * SavingsBalance.
 */
describe("/qr/pending/:id/deduct", () => {
  async function buildAppWithSheets() {
    vi.resetModules();
    vi.stubEnv("SHEETS_MOCK_MODE", "true");
    vi.stubEnv("PYTHON_BACKEND_URL", BACKEND);

    const { qrRouter } = await import("../src/routes/qr");
    const sheets = await import("../src/sheets/client");

    const app = express();
    app.use(express.json());
    app.use("/qr", qrRouter);
    return { app, sheets };
  }

  it("writes a PriceHistory row using the item's own purchase date", async () => {
    const { app, sheets } = await buildAppWithSheets();
    const pending = await sheets.appendPendingSavingsItem({
      date: "2026-07-28",
      store: "Big C",
      masterItemName: "ตู้เย็น",
      category: "goods",
      price: 12000,
      quantity: 1,
      discount: 0,
    });

    const response = await request(app).post(`/qr/pending/${pending.id}/deduct`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, id: pending.id });
    expect(await sheets.readPendingSavingsItems()).toHaveLength(0);
    expect(await sheets.readPriceHistory()).toMatchObject([
      { date: "2026-07-28", store: "Big C", masterItemName: "ตู้เย็น", price: 12000 },
    ]);
  });

  it("logs a SavingsWithdrawal for the item's line total", async () => {
    const { app, sheets } = await buildAppWithSheets();
    const pending = await sheets.appendPendingSavingsItem({
      date: "2026-07-28",
      store: "Big C",
      masterItemName: "ตู้เย็น",
      category: "goods",
      price: 12000,
      quantity: 1,
      discount: 500,
    });

    await request(app).post(`/qr/pending/${pending.id}/deduct`);

    expect(await sheets.readSavingsWithdrawals()).toMatchObject([
      { date: "2026-07-28", masterItemName: "ตู้เย็น", category: "goods", amount: 11500 },
    ]);
  });

  it("lowers the item's own cycle's savings balance by the line total", async () => {
    // 28 Jul with no custom paydays configured opens the "2026-08" cycle --
    // same estimation income.test.ts pins for the same date.
    const { app, sheets } = await buildAppWithSheets();
    await sheets.upsertCycleRow({ key: "2026-08", savingsBalance: 20000 });
    const pending = await sheets.appendPendingSavingsItem({
      date: "2026-07-28",
      store: null,
      masterItemName: "ตู้เย็น",
      category: "goods",
      price: 12000,
      quantity: 1,
      discount: 0,
    });

    await request(app).post(`/qr/pending/${pending.id}/deduct`);

    const [cycle] = await sheets.readCycleRows();
    expect(cycle).toMatchObject({ savingsBalance: 8000 });
  });

  it("treats an unset savings balance as zero rather than refusing to touch it", async () => {
    // Unlike money leaving by a route the app never sees, this decrement is
    // fully known -- the user just confirmed it -- so there's nothing lost
    // by starting the count from zero on an otherwise-blank cycle.
    const { app, sheets } = await buildAppWithSheets();
    const pending = await sheets.appendPendingSavingsItem({
      date: "2026-07-28",
      store: null,
      masterItemName: "ตู้เย็น",
      category: "goods",
      price: 12000,
      quantity: 1,
      discount: 0,
    });

    await request(app).post(`/qr/pending/${pending.id}/deduct`);

    const [cycle] = await sheets.readCycleRows();
    expect(cycle).toMatchObject({ savingsBalance: -12000 });
  });

  it("404s deducting an id that doesn't exist", async () => {
    const { app } = await buildAppWithSheets();

    const response = await request(app).post("/qr/pending/does-not-exist/deduct");

    expect(response.status).toBe(404);
  });
});

describe("GET /qr/withdrawals", () => {
  async function buildAppWithSheets() {
    vi.resetModules();
    vi.stubEnv("SHEETS_MOCK_MODE", "true");
    vi.stubEnv("PYTHON_BACKEND_URL", BACKEND);

    const { qrRouter } = await import("../src/routes/qr");
    const sheets = await import("../src/sheets/client");

    const app = express();
    app.use(express.json());
    app.use("/qr", qrRouter);
    return { app, sheets };
  }

  it("is empty for a fresh install", async () => {
    const { app } = await buildAppWithSheets();

    const { body } = await request(app).get("/qr/withdrawals");

    expect(body.withdrawals).toEqual([]);
  });

  it("returns newest first", async () => {
    const { app, sheets } = await buildAppWithSheets();
    await sheets.appendSavingsWithdrawal({
      date: "2026-06-25",
      masterItemName: "ก",
      category: "goods",
      amount: 1,
    });
    await sheets.appendSavingsWithdrawal({
      date: "2026-08-25",
      masterItemName: "ข",
      category: "goods",
      amount: 3,
    });

    const { body } = await request(app).get("/qr/withdrawals");

    expect(body.withdrawals.map((w: any) => w.masterItemName)).toEqual(["ข", "ก"]);
  });

  it("filters by cycle when asked, and returns the cycle's own bounds", async () => {
    const { app, sheets } = await buildAppWithSheets();
    await sheets.appendSavingsWithdrawal({
      date: "2026-06-25",
      masterItemName: "ก",
      category: "goods",
      amount: 1,
    }); // 2026-07 cycle
    await sheets.appendSavingsWithdrawal({
      date: "2026-07-28",
      masterItemName: "ข",
      category: "goods",
      amount: 2,
    }); // 2026-08 cycle

    const { body } = await request(app).get("/qr/withdrawals?cycle=2026-08");

    expect(body.cycle).toMatchObject({ key: "2026-08" });
    expect(body.withdrawals).toHaveLength(1);
    expect(body.withdrawals[0].masterItemName).toBe("ข");
  });

  it("rejects a malformed cycle key", async () => {
    const { app } = await buildAppWithSheets();

    const response = await request(app).get("/qr/withdrawals?cycle=not-a-cycle");

    expect(response.status).toBe(400);
  });
});
