/**
 * Bridges the Cycles tab to the pure math in ./cycles.
 *
 * Kept separate so `cycles.ts` stays free of I/O and stays unit-testable
 * on its own, while `/budget` and `/dashboard` share one way of turning
 * the user's recorded paydays into actual date ranges.
 */
import { buildCycleRange, cycleForDate, type Cycle } from "./cycles";
import { readCycleRows, upsertCycleRow, type CycleRow } from "./sheets/client";

export async function loadCycles(fromKey: string, toKey: string): Promise<Cycle[]> {
  const rows = await readCycleRows();
  return buildCycleRange(
    fromKey,
    toKey,
    rows
      .filter((row): row is CycleRow & { payday: string } => Boolean(row.payday))
      .map((row) => ({ key: row.key, payday: row.payday })),
  );
}

/**
 * The cycle a date falls in.
 *
 * The range spans the neighbouring years because the answer often isn't in
 * the date's own year: spend on 26 December belongs to the *next* January's
 * cycle, and spend on 2 January to the previous December's.
 */
export async function cycleContaining(date: string): Promise<Cycle | null> {
  const year = Number(date.slice(0, 4));
  return cycleForDate(date, await loadCycles(`${year - 1}-12`, `${year + 1}-01`));
}

/**
 * Nudges the cycle containing `date`'s SavingsBalance by `delta` (positive
 * or negative). Shared by every place that folds a fully-known change into
 * the balance immediately instead of waiting for the next hand-typed
 * correction: a savings-tagged Income deposit (and its edit/delete), and a
 * confirmed "deduct" settlement (and its edit/delete). A no-op if the date
 * falls outside every recorded cycle.
 */
export async function adjustSavingsBalance(date: string, delta: number): Promise<void> {
  const cycle = await cycleContaining(date);
  if (!cycle) return;
  const existing = (await readCycleRows()).find((row) => row.key === cycle.key);
  await upsertCycleRow({ key: cycle.key, savingsBalance: (existing?.savingsBalance ?? 0) + delta });
}
