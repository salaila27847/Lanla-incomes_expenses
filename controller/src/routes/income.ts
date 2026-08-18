import { Router } from "express";
import { cycleContaining, loadCycles } from "../cycleService";
import { isCycleKey, isDate } from "../cycles";
import {
  appendIncome,
  deleteIncome,
  readCycleRows,
  readIncome,
  upsertCycleRow,
  type IncomeDestination,
} from "../sheets/client";

export const incomeRouter = Router();

// Entries are dated, not cycle-stamped: which cycle a payment belongs to
// depends on the payday calendar, which the user can still edit afterwards.
// Storing the date keeps the answer correct when they do.
incomeRouter.get("/", async (req, res) => {
  const year = typeof req.query.year === "string" ? req.query.year : null;
  const cycleKey = typeof req.query.cycle === "string" ? req.query.cycle : null;
  const entries = await readIncome();

  if (cycleKey) {
    if (!isCycleKey(cycleKey)) {
      res.status(400).json({ error: "cycle must look like YYYY-MM" });
      return;
    }
    const [cycle] = await loadCycles(cycleKey, cycleKey);
    res.json({
      cycle,
      entries: entries
        .filter((entry) => entry.date >= cycle.payday && entry.date <= cycle.end)
        .sort((a, b) => b.date.localeCompare(a.date)),
    });
    return;
  }

  res.json({
    entries: (year ? entries.filter((entry) => entry.date.startsWith(year)) : entries).sort(
      (a, b) => b.date.localeCompare(a.date),
    ),
  });
});

// Distinct past sources with their most recent amount, so a salary or a
// recurring side income doesn't need retyping. Mirrors
// /budget/must-pay/recurring-names.
incomeRouter.get("/sources", async (_req, res) => {
  const latestAmountBySource = new Map<string, number>();
  for (const entry of (await readIncome()).sort((a, b) => a.date.localeCompare(b.date))) {
    latestAmountBySource.set(entry.source, entry.amount);
  }
  res.json({
    sources: Array.from(latestAmountBySource, ([source, amount]) => ({ source, amount })),
  });
});

incomeRouter.post("/", async (req, res) => {
  const { date, source, amount, destination_account } = req.body as {
    date?: unknown;
    source?: unknown;
    amount?: unknown;
    destination_account?: unknown;
  };

  if (typeof source !== "string" || !source.trim()) {
    res.status(400).json({ error: "source is required" });
    return;
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  if (typeof date !== "string" || !isDate(date)) {
    res.status(400).json({ error: "date must be a YYYY-MM-DD date" });
    return;
  }
  if (
    destination_account !== undefined &&
    destination_account !== "spending" &&
    destination_account !== "savings"
  ) {
    res.status(400).json({ error: "destination_account must be spending or savings" });
    return;
  }
  const destinationAccount = (destination_account as IncomeDestination | undefined) ?? "spending";

  const entry = await appendIncome({ date, source: source.trim(), amount, destinationAccount });

  // A savings-tagged deposit (a bonus, a windfall) rolls straight into that
  // cycle's SavingsBalance -- unlike money leaving the account by a route
  // the app never sees, this inflow is fully known the moment it's typed
  // in, so there's nothing to lose by folding it in immediately instead of
  // making the user go retype the running total by hand.
  if (destinationAccount === "savings") {
    const cycle = await cycleContaining(date);
    if (cycle) {
      const existing = (await readCycleRows()).find((row) => row.key === cycle.key);
      await upsertCycleRow({
        key: cycle.key,
        savingsBalance: (existing?.savingsBalance ?? 0) + amount,
      });
    }
  }

  res.status(201).json(entry);
});

incomeRouter.delete("/:id", async (req, res) => {
  await deleteIncome(req.params.id);
  res.json({ success: true, id: req.params.id });
});
