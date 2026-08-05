/**
 * Pay cycles.
 *
 * The user's month doesn't start on the 1st — it starts when their salary
 * lands and runs to the day before the next one. Paydays aren't a fixed
 * day-of-month either (they shift with weekends and holidays: the 23rd
 * through the 28th in practice), so the user enters the year's actual
 * dates and a cycle is simply [payday, next payday − 1 day]. That makes
 * cycles partition the timeline: no gaps, no overlaps, every date in
 * exactly one cycle.
 *
 * Cycles still need a YYYY-MM key — to head a dashboard column and to
 * stamp MustPay.Month. A cycle is named for the month whose 15th falls
 * inside it. Since cycles are ~1 month long and partition the timeline,
 * exactly one cycle contains any given 15th, so the naming is total and
 * collision-free. In practice it means a payday late in the month funds
 * the *next* month, which is how the user's own spreadsheet reads it:
 * 26 Dec – 28 Jan is the "January" column.
 *
 * Everything here is pure string/number math on YYYY-MM-DD — no Date
 * objects escape, so there's no local-timezone drift to reason about.
 */

export interface Cycle {
  key: string; // YYYY-MM
  payday: string; // YYYY-MM-DD, first day of the cycle
  end: string; // YYYY-MM-DD, last day of the cycle (the day before the next payday)
}

export interface PaydayEntry {
  key: string;
  payday: string;
}

// Only used when there is no payday on record at all — the first render of
// an empty install. The first real date the user enters supersedes it.
export const DEFAULT_PAYDAY_DAY = 25;

const CYCLE_KEY_PATTERN = /^\d{4}-\d{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isCycleKey(value: string): boolean {
  return CYCLE_KEY_PATTERN.test(value);
}

export function isDate(value: string): boolean {
  return DATE_PATTERN.test(value);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// Day 0 of the next month is the last day of this one — handles leap years
// without a special case.
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseCycleKey(key: string): { year: number; month: number } {
  const [year, month] = key.split("-").map(Number);
  return { year, month };
}

export function formatCycleKey(year: number, month: number): string {
  return `${year}-${pad(month)}`;
}

export function addMonthsToKey(key: string, delta: number): string {
  const { year, month } = parseCycleKey(key);
  const index = year * 12 + (month - 1) + delta;
  // Floor division plus a positive modulo, so negative deltas walk back
  // across a year boundary correctly.
  return formatCycleKey(Math.floor(index / 12), (((index % 12) + 12) % 12) + 1);
}

/** Whole months from `from` to `to`; negative when `to` is earlier. */
export function monthsBetweenKeys(from: string, to: string): number {
  const a = parseCycleKey(from);
  const b = parseCycleKey(to);
  return b.year * 12 + b.month - (a.year * 12 + a.month);
}

export function addDays(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

/** The cycle a payday opens — the one whose span contains a 15th. */
export function cycleKeyForPayday(payday: string): string {
  const [year, month] = payday.split("-").map(Number);
  const key = formatCycleKey(year, month);
  return dayOfMonth(payday) <= 15 ? key : addMonthsToKey(key, 1);
}

/**
 * Inverse of `cycleKeyForPayday`, for a cycle the user hasn't dated yet.
 * The day is clamped to the target month's length, so a 31st payday lands
 * on the 28th (or 29th) in February rather than overflowing into March.
 */
export function paydayForCycleKey(key: string, day: number): string {
  const target = day <= 15 ? key : addMonthsToKey(key, -1);
  const { year, month } = parseCycleKey(target);
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

// Gaps in the payday calendar borrow the day-of-month of the nearest date
// on record. Ties go to the earlier cycle, so the result doesn't depend on
// map ordering.
function typicalPaydayDay(key: string, known: PaydayEntry[]): number {
  let best: { distance: number; day: number } | null = null;
  for (const entry of known) {
    const distance = Math.abs(monthsBetweenKeys(key, entry.key));
    if (!best || distance < best.distance) {
      best = { distance, day: dayOfMonth(entry.payday) };
    }
  }
  return best?.day ?? DEFAULT_PAYDAY_DAY;
}

/**
 * Every cycle from `fromKey` to `toKey` inclusive, using the paydays the
 * user recorded and filling the rest in around them.
 *
 * One extra cycle past `toKey` is resolved and then dropped: without it
 * the last cycle in range has nothing to end against.
 */
export function buildCycleRange(
  fromKey: string,
  toKey: string,
  recorded: PaydayEntry[],
): Cycle[] {
  const known = recorded
    .filter((entry) => isCycleKey(entry.key) && isDate(entry.payday))
    .sort((a, b) => a.key.localeCompare(b.key));
  const byKey = new Map(known.map((entry) => [entry.key, entry.payday]));

  const keys: string[] = [];
  for (let key = fromKey; monthsBetweenKeys(key, toKey) >= -1; key = addMonthsToKey(key, 1)) {
    keys.push(key);
  }

  const resolved = keys
    .map((key) => ({ key, payday: byKey.get(key) ?? paydayForCycleKey(key, typicalPaydayDay(key, known)) }))
    .sort((a, b) => a.payday.localeCompare(b.payday));

  return resolved
    .map((entry, index) => ({
      key: entry.key,
      payday: entry.payday,
      end:
        index + 1 < resolved.length
          ? addDays(resolved[index + 1].payday, -1)
          : // Unreachable while the extra key above is in play, but keeps
            // the function total for a single-cycle range.
            addDays(paydayForCycleKey(addMonthsToKey(entry.key, 1), dayOfMonth(entry.payday)), -1),
    }))
    .filter(
      (cycle) => monthsBetweenKeys(fromKey, cycle.key) >= 0 && monthsBetweenKeys(cycle.key, toKey) >= 0,
    );
}

export function cycleForDate(date: string, cycles: Cycle[]): Cycle | null {
  // ISO dates compare correctly as strings.
  return cycles.find((cycle) => cycle.payday <= date && date <= cycle.end) ?? null;
}

export function cycleKeysInYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, index) => formatCycleKey(year, index + 1));
}
