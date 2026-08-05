/**
 * Bridges the Cycles tab to the pure math in ./cycles.
 *
 * Kept separate so `cycles.ts` stays free of I/O and stays unit-testable
 * on its own, while `/budget` and `/dashboard` share one way of turning
 * the user's recorded paydays into actual date ranges.
 */
import { buildCycleRange, cycleForDate, type Cycle } from "./cycles";
import { readCycleRows, type CycleRow } from "./sheets/client";

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
