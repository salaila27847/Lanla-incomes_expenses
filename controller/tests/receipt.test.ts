/**
 * /receipt/scan fans an uploaded image out to the Python backend (OCR,
 * then one fuzzy-match call per line) and returns an annotated list for
 * review. /receipt/confirm is the only write path into the sheet.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BACKEND = "http://backend.test";

async function buildApp() {
  vi.resetModules();
  vi.stubEnv("SHEETS_MOCK_MODE", "true");
  vi.stubEnv("PYTHON_BACKEND_URL", BACKEND);

  const { receiptRouter } = await import("../src/routes/receipt");
  const sheets = await import("../src/sheets/client");

  const app = express();
  app.use(express.json());
  app.use("/receipt", receiptRouter);
  return { app, sheets };
}

/** Stub the Python backend's /ocr and /match endpoints. */
function stubBackend(options: {
  ocr?: { status?: number; body?: unknown };
  match?: (rawText: string) => { status?: number; body?: unknown };
}) {
  const calls: { url: string; body?: unknown }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const target = String(url);
      if (target.endsWith("/ocr/")) {
        calls.push({ url: target });
        const { status = 200, body = { store: null, purchased_at: null, items: [] } } =
          options.ocr ?? {};
        return new Response(JSON.stringify(body), { status });
      }
      if (target.endsWith("/match/")) {
        const parsed = JSON.parse(String(init.body));
        calls.push({ url: target, body: parsed });
        const { status = 200, body = { matched: false, master_item_name: null, score: 0 } } =
          options.match?.(parsed.raw_text) ?? {};
        return new Response(JSON.stringify(body), { status });
      }
      throw new Error(`unexpected fetch to ${target}`);
    }),
  );

  return calls;
}

const ocrTwoItems = {
  store: "7-Eleven",
  purchased_at: "2026-08-04",
  items: [
    { id: "1", raw_text: "นมสดUHT250ml", price: 15 },
    { id: "2", raw_text: "ของใหม่ไม่เคยซื้อ", price: 99 },
  ],
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /receipt/scan", () => {
  it("requires an image", async () => {
    const { app } = await buildApp();
    stubBackend({});

    const response = await request(app).post("/receipt/scan");

    expect(response.status).toBe(400);
  });

  it("sends the image to the backend and matches every line", async () => {
    const { app } = await buildApp();
    const calls = stubBackend({ ocr: { body: ocrTwoItems } });

    const response = await request(app)
      .post("/receipt/scan")
      .attach("image", Buffer.from("jpeg"), "receipt.jpg");

    expect(response.status).toBe(200);
    expect(calls.filter((c) => c.url.endsWith("/ocr/"))).toHaveLength(1);
    // One match call per OCR'd line -- a line that silently skipped
    // matching would always look brand new to the user.
    expect(calls.filter((c) => c.url.endsWith("/match/"))).toHaveLength(2);
  });

  it("annotates matched lines with their master item and category", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendMasterItem("นมสด UHT 250ml", "food");
    stubBackend({
      ocr: { body: ocrTwoItems },
      match: (rawText) =>
        rawText === "นมสดUHT250ml"
          ? { body: { matched: true, master_item_name: "นมสด UHT 250ml", score: 95 } }
          : { body: { matched: false, master_item_name: null, score: 20 } },
    });

    const { body } = await request(app)
      .post("/receipt/scan")
      .attach("image", Buffer.from("jpeg"), "receipt.jpg");

    expect(body.store).toBe("7-Eleven");
    expect(body.items[0]).toMatchObject({
      raw_text: "นมสดUHT250ml",
      matched: true,
      master_item_name: "นมสด UHT 250ml",
      category: "food", // carried over from the master list, not guessed
    });
    expect(body.items[1]).toMatchObject({
      matched: false,
      master_item_name: null,
      category: null,
    });
  });

  it("offers the master item list as match candidates", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendMasterItem("นมสด UHT 250ml", "food");
    await sheets.appendMasterItem("สบู่เหลว", "goods");
    const calls = stubBackend({ ocr: { body: ocrTwoItems } });

    await request(app).post("/receipt/scan").attach("image", Buffer.from("j"), "r.jpg");

    const matchCall = calls.find((c) => c.url.endsWith("/match/"))!;
    expect((matchCall.body as any).candidate_master_items).toEqual([
      "นมสด UHT 250ml",
      "สบู่เหลว",
    ]);
  });

  it("surfaces an OCR backend failure as 502", async () => {
    const { app } = await buildApp();
    stubBackend({ ocr: { status: 500, body: { detail: "boom" } } });

    const response = await request(app)
      .post("/receipt/scan")
      .attach("image", Buffer.from("jpeg"), "receipt.jpg");

    expect(response.status).toBe(502);
  });

  it("treats a failed match as unmatched instead of losing the line", async () => {
    // A flaky match call must not drop a purchased item off the receipt.
    const { app } = await buildApp();
    stubBackend({ ocr: { body: ocrTwoItems }, match: () => ({ status: 500 }) });

    const { body } = await request(app)
      .post("/receipt/scan")
      .attach("image", Buffer.from("jpeg"), "receipt.jpg");

    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ matched: false, score: 0 });
  });
});

describe("POST /receipt/confirm", () => {
  const confirmBody = {
    store: "7-Eleven",
    purchased_at: "2026-08-04",
    items: [
      { raw_text: "นมสดUHT250ml", price: 15, master_item_name: "นมสด UHT 250ml", category: "food" },
    ],
  };

  it("writes a price history row and creates the new master item", async () => {
    const { app, sheets } = await buildApp();

    const response = await request(app).post("/receipt/confirm").send(confirmBody);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      new_master_items_added: 1,
      price_history_rows_written: 1,
    });
    expect(await sheets.readPriceHistory()).toMatchObject([
      {
        date: "2026-08-04",
        store: "7-Eleven",
        masterItemName: "นมสด UHT 250ml",
        category: "food",
        price: 15,
      },
    ]);
  });

  it("does not duplicate a master item that already exists", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendMasterItem("นมสด UHT 250ml", "food");

    const response = await request(app).post("/receipt/confirm").send(confirmBody);

    expect(response.body.new_master_items_added).toBe(0);
    expect(await sheets.readMasterItems()).toHaveLength(1);
  });

  it("creates a repeated new name only once within one receipt", async () => {
    // Two lines of the same product on one receipt: two price rows, but
    // only one master item.
    const { app, sheets } = await buildApp();

    const response = await request(app)
      .post("/receipt/confirm")
      .send({
        ...confirmBody,
        items: [confirmBody.items[0], { ...confirmBody.items[0], price: 16 }],
      });

    expect(response.body.new_master_items_added).toBe(1);
    expect(response.body.price_history_rows_written).toBe(2);
    expect(await sheets.readMasterItems()).toHaveLength(1);
  });

  it("falls back to today when the receipt has no date", async () => {
    const { app, sheets } = await buildApp();

    await request(app)
      .post("/receipt/confirm")
      .send({ ...confirmBody, purchased_at: null });

    const [row] = await sheets.readPriceHistory();
    expect(row.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it("stores a missing store as null", async () => {
    const { app, sheets } = await buildApp();

    await request(app)
      .post("/receipt/confirm")
      .send({ ...confirmBody, store: null });

    expect((await sheets.readPriceHistory())[0].store).toBeNull();
  });

  describe("paid_from", () => {
    it("defaults to spending, unchanged from before the field existed", async () => {
      const { app, sheets } = await buildApp();

      await request(app).post("/receipt/confirm").send(confirmBody);

      expect(await sheets.readPriceHistory()).toHaveLength(1);
      expect(await sheets.readPendingSavingsItems()).toHaveLength(0);
    });

    it("holds a savings-paid line back from PriceHistory", async () => {
      const { app, sheets } = await buildApp();

      const response = await request(app)
        .post("/receipt/confirm")
        .send({
          ...confirmBody,
          items: [{ ...confirmBody.items[0], paid_from: "savings" }],
        });

      expect(response.body).toMatchObject({
        price_history_rows_written: 0,
        pending_savings_rows_written: 1,
      });
      expect(await sheets.readPriceHistory()).toHaveLength(0);
      expect(await sheets.readPendingSavingsItems()).toMatchObject([
        { masterItemName: "นมสด UHT 250ml", category: "food", price: 15, date: "2026-08-04" },
      ]);
    });

    it("still creates the master item for a savings-paid line", async () => {
      const { app, sheets } = await buildApp();

      await request(app)
        .post("/receipt/confirm")
        .send({
          ...confirmBody,
          items: [{ ...confirmBody.items[0], paid_from: "savings" }],
        });

      expect(await sheets.readMasterItems()).toMatchObject([
        { name: "นมสด UHT 250ml", category: "food" },
      ]);
    });

    it("splits a mixed receipt between the two", async () => {
      const { app, sheets } = await buildApp();

      const response = await request(app)
        .post("/receipt/confirm")
        .send({
          ...confirmBody,
          items: [
            confirmBody.items[0],
            { ...confirmBody.items[0], master_item_name: "ผงซักฟอก", category: "goods", paid_from: "savings" },
          ],
        });

      expect(response.body).toMatchObject({
        price_history_rows_written: 1,
        pending_savings_rows_written: 1,
      });
      expect(await sheets.readPriceHistory()).toHaveLength(1);
      expect(await sheets.readPendingSavingsItems()).toHaveLength(1);
    });
  });

  describe("rejects incomplete input without writing anything", () => {
    it("an empty item list", async () => {
      const { app, sheets } = await buildApp();

      const response = await request(app)
        .post("/receipt/confirm")
        .send({ ...confirmBody, items: [] });

      expect(response.status).toBe(400);
      expect(await sheets.readPriceHistory()).toMatchObject([]);
    });

    it("an item with no master item name", async () => {
      // The user has to name every line before saving; a blank name would
      // create an unnamed master item that price lookup can never find.
      const { app, sheets } = await buildApp();

      const response = await request(app)
        .post("/receipt/confirm")
        .send({
          ...confirmBody,
          items: [{ ...confirmBody.items[0], master_item_name: "" }],
        });

      expect(response.status).toBe(400);
      expect(await sheets.readMasterItems()).toEqual([]);
    });

    it("validates the whole batch before writing any of it", async () => {
      // A bad second line must not leave the first one half-written.
      const { app, sheets } = await buildApp();

      const response = await request(app)
        .post("/receipt/confirm")
        .send({
          ...confirmBody,
          items: [confirmBody.items[0], { ...confirmBody.items[0], category: "" }],
        });

      expect(response.status).toBe(400);
      expect(await sheets.readPriceHistory()).toMatchObject([]);
    });
  });
});

describe("backend reachability", () => {
  it("reports an unreachable OCR backend instead of crashing", async () => {
    // fetch rejects rather than resolving when nothing is listening. Left
    // unhandled that killed the whole controller process in local dev.
    const { app } = await buildApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const response = await request(app)
      .post("/receipt/scan")
      .attach("image", Buffer.from("fake"), "receipt.jpg");

    expect(response.status).toBe(502);
    expect(response.body.error).toContain("unreachable");
  });

  it("falls back to an unmatched line when only matching is unreachable", async () => {
    // The line still has its text and price, and picking by hand is now a
    // normal path — losing the whole scan over it would be a bad trade.
    const { app } = await buildApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).includes("/match/")) throw new TypeError("fetch failed");
        return new Response(
          JSON.stringify({
            store: "Lotus",
            purchased_at: "2026-08-04",
            items: [{ id: "1", raw_text: "นมสด", price: 15, quantity: 2 }],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const response = await request(app)
      .post("/receipt/scan")
      .attach("image", Buffer.from("fake"), "receipt.jpg");

    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({
      raw_text: "นมสด",
      price: 15,
      quantity: 2,
      matched: false,
      candidates: [],
    });
  });
});
