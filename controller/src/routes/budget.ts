import { Router } from "express";
import { cycleContaining } from "../cycleService";
import { loadSettings } from "../settings";
import {
  lineTotal,
  appendMustPayItem,
  appendRecurringBill,
  deleteMustPayItem,
  deleteRecurringBill,
  readMustPayItems,
  readPriceHistory,
  readRecurringBills,
  updateMustPayStatus,
  updateRecurringBill,
  type RecurringBill,
} from "../sheets/client";

export const budgetRouter = Router();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Turns each active RecurringBill into this cycle's MustPay row, the first
// time this cycle is asked for and never again — existing rows tagged with
// a group's key are how it tells "already generated" from "the user typed
// this name by hand". Several bills sharing a cardGroup collapse into one
// row (one card statement, not one transfer per thing on it); an ungrouped
// bill is a group of one, keyed by its own id.
async function generateRecurringMustPay(cycleKey: string): Promise<void> {
  const [bills, existingMustPay] = await Promise.all([readRecurringBills(), readMustPayItems()]);

  const alreadyGenerated = new Set(
    existingMustPay
      .filter((item) => item.month === cycleKey && item.recurringGroupKey)
      .map((item) => item.recurringGroupKey),
  );

  const groups = new Map<string, RecurringBill[]>();
  for (const bill of bills) {
    if (!bill.active) continue;
    const key = bill.cardGroup ?? bill.id;
    const group = groups.get(key) ?? [];
    group.push(bill);
    groups.set(key, group);
  }

  for (const [groupKey, groupBills] of groups) {
    if (alreadyGenerated.has(groupKey)) continue;

    const amount = groupBills.reduce((sum, bill) => sum + bill.amount, 0);
    // A shared card is named for the card, not whichever instalment
    // happens to be first — that's what the statement itself says.
    const name = groupBills[0].cardGroup ?? groupBills[0].name;
    await appendMustPayItem({ name, amount, month: cycleKey, recurringGroupKey: groupKey });

    await Promise.all(
      groupBills.map((bill) => {
        if (bill.installmentsRemaining === null) return null; // no end date: recurs forever
        const remaining = bill.installmentsRemaining - 1;
        return updateRecurringBill(bill.id, {
          installmentsRemaining: remaining,
          active: remaining > 0,
        });
      }),
    );
  }
}

// The caps are per pay cycle, not per day. An earlier version compared
// today's spend alone against 5,000 — unreachable in a day at this budget,
// so the page never said anything useful. The user's own spreadsheet reads
// "เป้าหมาย 5,000/เดือน" against actuals of 4,000–6,000 a month.
budgetRouter.get("/", async (_req, res) => {
  const cycle = await cycleContaining(today());
  if (cycle) await generateRecurringMustPay(cycle.key);

  const [settings, priceHistory, mustPayItems, recurringBills] = await Promise.all([
    loadSettings(),
    readPriceHistory(),
    readMustPayItems(),
    readRecurringBills(),
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
    recurringBills: recurringBills.filter((bill) => bill.active),
  });
});

budgetRouter.post("/recurring", async (req, res) => {
  const { name, amount, cardGroup, installments } = req.body as {
    name?: string;
    amount?: number;
    cardGroup?: string | null;
    installments?: number | null;
  };
  if (!name || typeof amount !== "number" || amount <= 0) {
    res.status(400).json({ error: "name and a positive amount are required" });
    return;
  }
  if (installments != null && (!Number.isInteger(installments) || installments <= 0)) {
    res.status(400).json({ error: "installments must be a positive whole number, or omitted" });
    return;
  }

  res.status(201).json(
    await appendRecurringBill({
      name,
      amount,
      cardGroup: cardGroup || null,
      installmentsRemaining: installments ?? null,
    }),
  );
});

// Stops a recurring bill from generating any further — paid off early,
// cancelled, whatever the reason. Doesn't touch rows already generated
// from it, so past cycles keep reading exactly as they did.
budgetRouter.post("/recurring/:id/stop", async (req, res) => {
  if (!(await updateRecurringBill(req.params.id, { active: false }))) {
    res.status(404).json({ error: "recurring bill not found" });
    return;
  }
  res.json({ success: true, id: req.params.id });
});

// For correcting a bill added by mistake — distinct from "stop", which
// keeps the bill around (inactive) as a record of what it was.
budgetRouter.delete("/recurring/:id", async (req, res) => {
  if (!(await deleteRecurringBill(req.params.id))) {
    res.status(404).json({ error: "recurring bill not found" });
    return;
  }
  res.json({ success: true, id: req.params.id });
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
