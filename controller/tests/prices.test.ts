/**
 * /prices answers "where is this cheapest, and has it gone up?" — so the
 * grouping by store and the newest-first ordering are the feature, not
 * incidental formatting.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function buildApp() {
  vi.resetModules();
  vi.stubEnv("SHEETS_MOCK_MODE", "true");

  const { pricesRouter } = await import("../src/routes/prices");
  const sheets = await import("../src/sheets/client");

  const app = express();
  app.use("/prices", pricesRouter);
  return { app, sheets };
}

const milkAt = (store: string | null, price: number, date: string) => ({
  date,
  store,
  masterItemName: "นมสด UHT 250ml",
  category: "food" as const,
  price,
});

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /prices", () => {
  it("returns nothing for an empty query rather than the whole sheet", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow(milkAt("7-Eleven", 15, "2026-08-04"));

    const { body } = await request(app).get("/prices");

    expect(body).toEqual({ query: "", groups: [] });
  });

  it("ignores a whitespace-only query", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow(milkAt("7-Eleven", 15, "2026-08-04"));

    const { body } = await request(app).get("/prices").query({ item: "   " });

    expect(body.groups).toEqual([]);
  });

  it("matches on a substring of the item name", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow(milkAt("7-Eleven", 15, "2026-08-04"));

    const { body } = await request(app).get("/prices").query({ item: "นมสด" });

    expect(body.query).toBe("นมสด");
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].entries).toHaveLength(1);
  });

  it("excludes items that do not match", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow(milkAt("7-Eleven", 15, "2026-08-04"));
    await sheets.appendPriceHistoryRow({
      ...milkAt("7-Eleven", 59, "2026-08-04"),
      masterItemName: "สบู่เหลว",
      category: "goods",
    });

    const { body } = await request(app).get("/prices").query({ item: "นมสด" });

    expect(body.groups[0].entries).toHaveLength(1);
    expect(body.groups[0].entries[0].masterItemName).toBe("นมสด UHT 250ml");
  });

  it("matches case-insensitively", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow({
      ...milkAt("7-Eleven", 15, "2026-08-04"),
      masterItemName: "Milk UHT",
    });

    const { body } = await request(app).get("/prices").query({ item: "milk" });

    expect(body.groups).toHaveLength(1);
  });

  it("groups the same item by store so prices can be compared", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow(milkAt("7-Eleven", 15, "2026-08-04"));
    await sheets.appendPriceHistoryRow(milkAt("Lotus", 13, "2026-08-04"));

    const { body } = await request(app).get("/prices").query({ item: "นมสด" });

    expect(body.groups.map((g: any) => g.store)).toEqual(["7-Eleven", "Lotus"]);
    expect(body.groups.every((g: any) => g.entries.length === 1)).toBe(true);
  });

  it("orders each store's entries newest first", async () => {
    // The most recent price is the one worth seeing first.
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow(milkAt("7-Eleven", 15, "2026-06-01"));
    await sheets.appendPriceHistoryRow(milkAt("7-Eleven", 17, "2026-08-04"));
    await sheets.appendPriceHistoryRow(milkAt("7-Eleven", 16, "2026-07-01"));

    const { body } = await request(app).get("/prices").query({ item: "นมสด" });

    expect(body.groups[0].entries.map((e: any) => e.date)).toEqual([
      "2026-08-04",
      "2026-07-01",
      "2026-06-01",
    ]);
  });

  it("labels rows with no store instead of dropping them", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow(milkAt(null, 15, "2026-08-04"));

    const { body } = await request(app).get("/prices").query({ item: "นมสด" });

    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].store).toBe("ไม่ระบุร้าน");
  });

  it("returns an empty result when nothing matches", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendPriceHistoryRow(milkAt("7-Eleven", 15, "2026-08-04"));

    const { body } = await request(app).get("/prices").query({ item: "ไม่มีสินค้านี้" });

    expect(body.groups).toEqual([]);
  });
});

describe("GET /prices/item-names", () => {
  it("is empty for a fresh install", async () => {
    const { app } = await buildApp();

    const { body } = await request(app).get("/prices/item-names");

    expect(body.names).toEqual([]);
  });

  it("lists each master item name once", async () => {
    const { app, sheets } = await buildApp();
    await sheets.appendMasterItem("นมสด UHT 250ml", "food");
    await sheets.appendMasterItem("สบู่เหลว", "goods");
    await sheets.appendMasterItem("นมสด UHT 250ml", "food");

    const { body } = await request(app).get("/prices/item-names");

    // Feeds a search datalist -- duplicates would show as repeated options.
    expect(body.names).toEqual(["นมสด UHT 250ml", "สบู่เหลว"]);
  });
});
