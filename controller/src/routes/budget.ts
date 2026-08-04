import { Router } from "express";
import {
  appendMustPayItem,
  readMustPayItems,
  readPriceHistory,
  updateMustPayStatus,
} from "../sheets/client";

export const budgetRouter = Router();

// Matches SPEC.md's exact daily caps — not configurable yet.
const DAILY_BUDGET_THB = { food: 5000, goods: 5000 };

function todayAndMonth(): { today: string; month: string } {
  const today = new Date().toISOString().slice(0, 10);
  return { today, month: today.slice(0, 7) };
}

budgetRouter.get("/", async (_req, res) => {
  const { today, month } = todayAndMonth();

  const priceHistory = await readPriceHistory();
  const spentToday = { food: 0, goods: 0 };
  for (const row of priceHistory) {
    if (row.date === today) {
      spentToday[row.category] += row.price;
    }
  }

  const mustPay = (await readMustPayItems()).filter((item) => item.month === month);

  res.json({ dailyBudget: DAILY_BUDGET_THB, spentToday, mustPay });
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
  const { month } = todayAndMonth();
  const item = await appendMustPayItem({ name, amount, month });
  res.status(201).json(item);
});

budgetRouter.post("/must-pay/:id/mark-paid", async (req, res) => {
  await updateMustPayStatus(req.params.id, "paid");
  res.json({ success: true, id: req.params.id, status: "paid" });
});
