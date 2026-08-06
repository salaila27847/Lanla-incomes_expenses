import { Router } from "express";
import { cycleContaining } from "../cycleService";
import { loadSettings } from "../settings";
import {
  lineTotal,
  appendMustPayItem,
  deleteMustPayItem,
  readMustPayItems,
  readPriceHistory,
  updateMustPayStatus,
} from "../sheets/client";

export const budgetRouter = Router();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// The caps are per pay cycle, not per day. An earlier version compared
// today's spend alone against 5,000 — unreachable in a day at this budget,
// so the page never said anything useful. The user's own spreadsheet reads
// "เป้าหมาย 5,000/เดือน" against actuals of 4,000–6,000 a month.
budgetRouter.get("/", async (_req, res) => {
  const [cycle, settings, priceHistory, mustPayItems] = await Promise.all([
    cycleContaining(today()),
    loadSettings(),
    readPriceHistory(),
    readMustPayItems(),
  ]);

  const spentThisCycle = { food: 0, goods: 0 };
  if (cycle) {
    for (const row of priceHistory) {
      if (row.date >= cycle.payday && row.date <= cycle.end) {
        // price is per unit and before any discount, so what was spent is
        // neither of them on its own.
        spentThisCycle[row.category] += lineTotal(row);
      }
    }
  }

  res.json({
    cycle,
    cycleBudget: { food: settings.cycleBudgetFood, goods: settings.cycleBudgetGoods },
    spentThisCycle,
    mustPay: mustPayItems.filter((item) => item.month === cycle?.key),
  });
});

// Distinct historical must-pay names (most recent amount per name), so
// the frontend can offer "pick an existing bill" instead of always
// typing one from scratch.
budgetRouter.get("/must-pay/recurring-names", async (_req, res) => {
  const items = await readMustPayItems();
  const latestAmountByName = new Map<string, number>();
  for (const item of items) {
    latestAmountByName.set(item.name, item.amount);
  }
  res.json({
    names: Array.from(latestAmountByName, ([name, amount]) => ({ name, amount })),
  });
});

budgetRouter.post("/must-pay", async (req, res) => {
  const { name, amount } = req.body as { name?: string; amount?: number };
  if (!name || typeof amount !== "number" || amount <= 0) {
    res.status(400).json({ error: "name and a positive amount are required" });
    return;
  }

  // Stamped with the cycle the bill falls in, not the calendar month, so a
  // bill added just after payday lands in the cycle that will pay it.
  const cycle = await cycleContaining(today());
  if (!cycle) {
    res.status(500).json({ error: "could not resolve the current pay cycle" });
    return;
  }

  res.status(201).json(await appendMustPayItem({ name, amount, month: cycle.key }));
});

// Marking a bill paid is a one-tap action sitting in a crowded row, so
// getting it wrong is easy — and without the reverse the only way back was
// to delete the bill and retype it.
for (const [path, status] of [
  ["mark-paid", "paid"],
  ["mark-unpaid", "unpaid"],
] as const) {
  budgetRouter.post(`/must-pay/:id/${path}`, async (req, res) => {
    if (!(await updateMustPayStatus(req.params.id, status))) {
      res.status(404).json({ error: "must-pay item not found" });
      return;
    }
    res.json({ success: true, id: req.params.id, status });
  });
}

// A bill added twice, or under the wrong name, was otherwise stuck on the
// checklist for good — the list is added to by hand, so it collects typos.
budgetRouter.delete("/must-pay/:id", async (req, res) => {
  if (!(await deleteMustPayItem(req.params.id))) {
    res.status(404).json({ error: "must-pay item not found" });
    return;
  }
  res.json({ success: true, id: req.params.id });
});
