import { Router } from "express";
import { cycleContaining } from "../cycleService";
import { loadSettings } from "../settings";
import {
  appendMustPayItem,
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
        spentThisCycle[row.category] += row.price;
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

budgetRouter.post("/must-pay/:id/mark-paid", async (req, res) => {
  await updateMustPayStatus(req.params.id, "paid");
  res.json({ success: true, id: req.params.id, status: "paid" });
});
