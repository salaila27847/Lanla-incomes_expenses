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
