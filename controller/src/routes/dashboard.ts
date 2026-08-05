import { Router } from "express";
import {
  buildCycleRange,
  cycleForDate,
  cycleKeyForPayday,
  cycleKeysInYear,
  isCycleKey,
  isDate,
  type Cycle,
} from "../cycles";
import { loadSettings, saveSettings, SETTING_KEYS, type SettingField } from "../settings";
import {
  readCycleRows,
  readIncome,
  readMustPayItems,
  readPriceHistory,
  upsertCycleRow,
  type CycleRow,
} from "../sheets/client";

export const dashboardRouter = Router();

type AmountsByCycle = Record<string, number>;

interface DashboardRow {
  name: string;
  amounts: AmountsByCycle;
}

function parseYear(value: unknown): number {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1970 && year <= 9999
    ? year
    : new Date().getFullYear();
}

function add(amounts: AmountsByCycle, key: string, value: number): void {
  amounts[key] = (amounts[key] ?? 0) + value;
}

function slice(amounts: AmountsByCycle, keys: string[]): AmountsByCycle {
  return Object.fromEntries(keys.map((key) => [key, amounts[key] ?? 0]));
}

/** Rows that are all zeros in the displayed year are noise — a bill paid off
 *  two years ago shouldn't keep its own line forever. */
function visibleRows(rows: Map<string, AmountsByCycle>, keys: string[]): DashboardRow[] {
  return Array.from(rows, ([name, amounts]) => ({ name, amounts: slice(amounts, keys) }))
    .filter((row) => keys.some((key) => row.amounts[key] !== 0))
    .sort((a, b) => a.name.localeCompare(b.name, "th"));
}

function paydaysFrom(rows: CycleRow[]) {
  return rows
    .filter((row): row is CycleRow & { payday: string } => Boolean(row.payday))
    .map((row) => ({ key: row.key, payday: row.payday }));
}

dashboardRouter.get("/", async (req, res) => {
  const year = parseYear(req.query.year);

  const [cycleRows, income, priceHistory, mustPay, settings] = await Promise.all([
    readCycleRows(),
    readIncome(),
    readPriceHistory(),
    readMustPayItems(),
    loadSettings(),
  ]);

  // The running balance has to start at the earliest cycle with any data,
  // not at January of the requested year — otherwise each year restarts
  // from the opening balance and every figure after the first is wrong.
  const dataYears = [
    ...cycleRows.map((row) => row.key),
    ...mustPay.map((item) => item.month),
    ...income.map((entry) => entry.date),
    ...priceHistory.map((row) => row.date),
  ]
    .map((value) => Number(String(value).slice(0, 4)))
    .filter((value) => Number.isInteger(value) && value >= 1970);
  const firstYear = Math.min(year, ...dataYears);

  const cycles = buildCycleRange(`${firstYear - 1}-12`, `${year}-12`, paydaysFrom(cycleRows));

  const incomeBySource = new Map<string, AmountsByCycle>();
  const incomeTotals: AmountsByCycle = {};
  for (const entry of income) {
    const cycle = cycleForDate(entry.date, cycles);
    if (!cycle) continue;
    const row = incomeBySource.get(entry.source) ?? {};
    add(row, cycle.key, entry.amount);
    incomeBySource.set(entry.source, row);
    add(incomeTotals, cycle.key, entry.amount);
  }

  // Must-pay items are already stamped with a cycle key, so they need no
  // date lookup. Unpaid ones count too: they're committed money, and a
  // balance that ignores them reads higher than what's actually spendable.
  const fixedByName = new Map<string, AmountsByCycle>();
  const fixedTotals: AmountsByCycle = {};
  for (const item of mustPay) {
    const row = fixedByName.get(item.name) ?? {};
    add(row, item.month, item.amount);
    fixedByName.set(item.name, row);
    add(fixedTotals, item.month, item.amount);
  }

  const variableByName = new Map<string, AmountsByCycle>([
    ["🍔 ค่ากิน", {}],
    ["🧴 ของใช้", {}],
  ]);
  const foodAmounts = variableByName.get("🍔 ค่ากิน")!;
  const goodsAmounts = variableByName.get("🧴 ของใช้")!;
  for (const row of priceHistory) {
    const cycle = cycleForDate(row.date, cycles);
    if (!cycle) continue;
    add(row.category === "food" ? foodAmounts : goodsAmounts, cycle.key, row.price);
  }

  const expenseTotals: AmountsByCycle = {};
  const netTotals: AmountsByCycle = {};
  const spendingBalance: AmountsByCycle = {};
  let running = settings.openingBalance;
  for (const cycle of cycles) {
    expenseTotals[cycle.key] =
      (fixedTotals[cycle.key] ?? 0) +
      (foodAmounts[cycle.key] ?? 0) +
      (goodsAmounts[cycle.key] ?? 0);
    netTotals[cycle.key] = (incomeTotals[cycle.key] ?? 0) - expenseTotals[cycle.key];
    running += netTotals[cycle.key];
    spendingBalance[cycle.key] = running;
  }

  const keys = cycleKeysInYear(year);
  const savingsByKey = new Map(cycleRows.map((row) => [row.key, row.savingsBalance]));
  const today = new Date().toISOString().slice(0, 10);

  res.json({
    year,
    cycles: cycles.filter((cycle) => keys.includes(cycle.key)),
    currentCycleKey: cycleForDate(today, cycles)?.key ?? null,
    sections: [
      { id: "income", title: "รายรับ", rows: visibleRows(incomeBySource, keys) },
      { id: "fixed", title: "รายจ่ายคงที่ / บิล", rows: visibleRows(fixedByName, keys) },
      { id: "variable", title: "ค่ากิน & ของใช้ (จากสลิป)", rows: visibleRows(variableByName, keys) },
    ],
    totals: {
      income: slice(incomeTotals, keys),
      expense: slice(expenseTotals, keys),
      net: slice(netTotals, keys),
      spendingBalance: slice(spendingBalance, keys),
      savingsBalance: Object.fromEntries(keys.map((key) => [key, savingsByKey.get(key) ?? null])),
    },
    budget: { food: settings.cycleBudgetFood, goods: settings.cycleBudgetGoods },
    settings,
  });
});

dashboardRouter.get("/settings", async (_req, res) => {
  res.json(await loadSettings());
});

dashboardRouter.put("/settings", async (req, res) => {
  const body = req.body as Partial<Record<SettingField, unknown>>;
  const updates: Partial<Record<SettingField, number>> = {};

  for (const field of Object.keys(SETTING_KEYS) as SettingField[]) {
    if (body[field] === undefined) continue;
    const value = Number(body[field]);
    if (!Number.isFinite(value)) {
      res.status(400).json({ error: `${field} must be a number` });
      return;
    }
    updates[field] = value;
  }

  res.json(await saveSettings(updates));
});

/** The year's cycles with whatever the user has filled in so far, so the
 *  payday calendar can show which months are still assumed rather than set. */
dashboardRouter.get("/cycles", async (req, res) => {
  const year = parseYear(req.query.year);
  const rows = await readCycleRows();
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const cycles = buildCycleRange(`${year}-01`, `${year}-12`, paydaysFrom(rows));

  res.json({
    year,
    cycles: cycles.map((cycle: Cycle) => ({
      ...cycle,
      savingsBalance: byKey.get(cycle.key)?.savingsBalance ?? null,
      paydayIsRecorded: Boolean(byKey.get(cycle.key)?.payday),
    })),
  });
});

dashboardRouter.put("/cycles/:key", async (req, res) => {
  const { key } = req.params;
  if (!isCycleKey(key)) {
    res.status(400).json({ error: "cycle key must look like YYYY-MM" });
    return;
  }

  const { payday, savingsBalance } = req.body as {
    payday?: unknown;
    savingsBalance?: unknown;
  };
  const update: { key: string; payday?: string | null; savingsBalance?: number | null } = { key };

  if (payday !== undefined) {
    if (payday === null || payday === "") {
      update.payday = null;
    } else if (typeof payday !== "string" || !isDate(payday)) {
      res.status(400).json({ error: "payday must be a YYYY-MM-DD date" });
      return;
    } else if (cycleKeyForPayday(payday) !== key) {
      // Cycles are named for the month whose 15th they contain, so a date
      // outside that window would give two cycles the same key and silently
      // merge their columns.
      res.status(400).json({
        error: `${payday} opens cycle ${cycleKeyForPayday(payday)}, not ${key}`,
      });
      return;
    } else {
      update.payday = payday;
    }
  }

  if (savingsBalance !== undefined) {
    if (savingsBalance === null || savingsBalance === "") {
      update.savingsBalance = null;
    } else if (!Number.isFinite(Number(savingsBalance))) {
      res.status(400).json({ error: "savingsBalance must be a number" });
      return;
    } else {
      update.savingsBalance = Number(savingsBalance);
    }
  }

  res.json(await upsertCycleRow(update));
});
