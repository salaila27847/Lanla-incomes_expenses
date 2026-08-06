import { Router } from "express";
import { isDiscountOnly, readMasterItems, readPriceHistory } from "../sheets/client";

export const pricesRouter = Router();

const NO_STORE_LABEL = "ไม่ระบุร้าน";

pricesRouter.get("/", async (req, res) => {
  const item = typeof req.query.item === "string" ? req.query.item.trim() : "";
  if (!item) {
    res.json({ query: "", groups: [] });
    return;
  }

  const needle = item.toLowerCase();
  const matches = (await readPriceHistory()).filter(
    // A bill-level discount is a row but not a price; comparing "ส่วนลด
    // ท้ายบิล" across stores is meaningless.
    (row) => !isDiscountOnly(row) && row.masterItemName.toLowerCase().includes(needle),
  );

  const byStore = new Map<
    string,
    {
      masterItemName: string;
      price: number;
      quantity: number;
      discount: number;
      netPrice: number;
      date: string;
    }[]
  >();
  for (const row of matches) {
    const store = row.store ?? NO_STORE_LABEL;
    const entries = byStore.get(store) ?? [];
    // Unit price on purpose: comparing a 3-pack's total against a single
    // unit elsewhere is what makes a price history useless.
    //
    // `price` is the printed price and stays the headline, because a promo
    // you can't count on next time shouldn't become what the product
    // "costs". `netPrice` is what was actually paid per unit, for when the
    // discount is the interesting part.
    entries.push({
      masterItemName: row.masterItemName,
      price: row.price,
      quantity: row.quantity,
      discount: row.discount,
      netPrice: row.price - row.discount / row.quantity,
      date: row.date,
    });
    byStore.set(store, entries);
  }

  const groups = Array.from(byStore, ([store, entries]) => ({
    store,
    entries: entries.sort((a, b) => b.date.localeCompare(a.date)),
  })).sort((a, b) => a.store.localeCompare(b.store));

  res.json({ query: item, groups });
});

// Distinct master item names, for the search box's datalist.
pricesRouter.get("/item-names", async (_req, res) => {
  const names = (await readMasterItems()).map((item) => item.name);
  res.json({ names: Array.from(new Set(names)) });
});
