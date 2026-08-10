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
