import { Router } from "express";
import { readMasterItems, readPriceHistory } from "../sheets/client";

export const pricesRouter = Router();

const NO_STORE_LABEL = "ไม่ระบุร้าน";

pricesRouter.get("/", async (req, res) => {
  const item = typeof req.query.item === "string" ? req.query.item.trim() : "";
  if (!item) {
    res.json({ query: "", groups: [] });
    return;
  }

  const needle = item.toLowerCase();
  const matches = (await readPriceHistory()).filter((row) =>
    row.masterItemName.toLowerCase().includes(needle),
  );

  const byStore = new Map<
    string,
    { masterItemName: string; price: number; quantity: number; date: string }[]
  >();
  for (const row of matches) {
    const store = row.store ?? NO_STORE_LABEL;
    const entries = byStore.get(store) ?? [];
    // Unit price on purpose: comparing a 3-pack's total against a single
    // unit elsewhere is what makes a price history useless.
    entries.push({
      masterItemName: row.masterItemName,
      price: row.price,
      quantity: row.quantity,
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
