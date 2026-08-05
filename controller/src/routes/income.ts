import { Router } from "express";
import { isDate } from "../cycles";
import { appendIncome, deleteIncome, readIncome } from "../sheets/client";

export const incomeRouter = Router();

// Entries are dated, not cycle-stamped: which cycle a payment belongs to
// depends on the payday calendar, which the user can still edit afterwards.
// Storing the date keeps the answer correct when they do.
incomeRouter.get("/", async (req, res) => {
  const year = typeof req.query.year === "string" ? req.query.year : null;
  const entries = await readIncome();
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
  const { date, source, amount } = req.body as {
    date?: unknown;
    source?: unknown;
    amount?: unknown;
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

  res.status(201).json(await appendIncome({ date, source: source.trim(), amount }));
});

incomeRouter.delete("/:id", async (req, res) => {
  await deleteIncome(req.params.id);
  res.json({ success: true, id: req.params.id });
});
