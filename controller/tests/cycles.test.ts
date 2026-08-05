/**
 * Pay-cycle math.
 *
 * The anchor here is the user's own spreadsheet (the uploaded
 * budget_dashboard.html): its twelve column headers each state a payday and
 * the month that payday funds. That mapping was written by hand, months
 * before this code existed, so it can't be bent to match whatever the
 * implementation happens to do — which is exactly what makes it worth
 * testing against.
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonthsToKey,
  buildCycleRange,
  cycleForDate,
  cycleKeyForPayday,
  monthsBetweenKeys,
  paydayForCycleKey,
} from "../src/cycles";

// Transcribed from the uploaded dashboard's <th> sub-labels: the date the
// salary landed, and the month column it belongs to.
const SPREADSHEET_COLUMNS: [payday: string, cycleKey: string][] = [
  ["2025-12-26", "2026-01"],
  ["2026-01-28", "2026-02"],
  ["2026-02-23", "2026-03"],
  ["2026-03-26", "2026-04"],
  ["2026-04-25", "2026-05"],
  ["2026-05-28", "2026-06"],
  ["2026-06-25", "2026-07"],
  ["2026-07-25", "2026-08"],
  ["2026-08-27", "2026-09"],
  ["2026-09-25", "2026-10"],
  ["2026-10-28", "2026-11"],
  ["2026-11-26", "2026-12"],
];

describe("cycleKeyForPayday", () => {
  it.each(SPREADSHEET_COLUMNS)("names the cycle opened on %s", (payday, cycleKey) => {
    expect(cycleKeyForPayday(payday)).toBe(cycleKey);
  });

  it("names a mid-month payday for its own month", () => {
    // Payday on the 5th: 5 Jan – 4 Feb contains 15 Jan, so it's January's.
    expect(cycleKeyForPayday("2026-01-05")).toBe("2026-01");
  });

  it("puts the boundary day with the month it starts in", () => {
    // The 15th is the last day that funds its own month: 15 Jan – 14 Feb
    // contains 15 Jan, whereas 16 Jan – 15 Feb contains 15 Feb.
    expect(cycleKeyForPayday("2026-01-15")).toBe("2026-01");
    expect(cycleKeyForPayday("2026-01-16")).toBe("2026-02");
  });

  it("rolls a December payday into the next year", () => {
    expect(cycleKeyForPayday("2025-12-26")).toBe("2026-01");
  });
});

describe("paydayForCycleKey", () => {
  it.each(SPREADSHEET_COLUMNS)("recovers %s from its cycle", (payday, cycleKey) => {
    expect(paydayForCycleKey(cycleKey, Number(payday.slice(8, 10)))).toBe(payday);
  });

  it("clamps a 31st payday to the end of a short month", () => {
    // March's cycle opens in February, which has no 31st. Overflowing
    // would land in March and flip the cycle it belongs to.
    expect(paydayForCycleKey("2026-03", 31)).toBe("2026-02-28");
    expect(cycleKeyForPayday("2026-02-28")).toBe("2026-03");
  });

  it("clamps to the 29th in a leap February", () => {
    expect(paydayForCycleKey("2028-03", 31)).toBe("2028-02-29");
  });

  it("walks back across a year boundary", () => {
    expect(paydayForCycleKey("2026-01", 26)).toBe("2025-12-26");
  });
});

describe("buildCycleRange", () => {
  const recorded = SPREADSHEET_COLUMNS.map(([payday, key]) => ({ key, payday }));

  it("returns exactly the requested keys", () => {
    const cycles = buildCycleRange("2026-01", "2026-12", recorded);

    expect(cycles.map((cycle) => cycle.key)).toEqual(
      SPREADSHEET_COLUMNS.map(([, key]) => key),
    );
  });

  it("ends each cycle the day before the next payday", () => {
    const cycles = buildCycleRange("2026-01", "2026-12", recorded);

    expect(cycles[0]).toEqual({ key: "2026-01", payday: "2025-12-26", end: "2026-01-27" });
    expect(cycles[1]).toEqual({ key: "2026-02", payday: "2026-01-28", end: "2026-02-22" });
  });

  it("leaves no gap or overlap between consecutive cycles", () => {
    // The whole point of the model: every date lands in exactly one cycle.
    const cycles = buildCycleRange("2026-01", "2026-12", recorded);

    for (let index = 1; index < cycles.length; index += 1) {
      expect(addDays(cycles[index - 1].end, 1)).toBe(cycles[index].payday);
    }
  });

  it("closes the final cycle even though its successor is out of range", () => {
    const cycles = buildCycleRange("2026-01", "2026-12", recorded);
    const december = cycles[cycles.length - 1];

    expect(december.payday).toBe("2026-11-26");
    expect(december.end > december.payday).toBe(true);
  });

  it("fills an undated cycle from the nearest recorded payday", () => {
    // The user enters the year's dates up front but may miss one; the
    // dashboard still has to render a column for it.
    const cycles = buildCycleRange(
      "2026-01",
      "2026-03",
      recorded.filter((entry) => entry.key !== "2026-02"),
    );

    // The nearest cycle still on record is January, whose salary landed on
    // the 26th (of December), so February borrows the 26th — of January,
    // since that's the month a late payday has to fall in to fund February.
    expect(cycles[1]).toMatchObject({ key: "2026-02", payday: "2026-01-26" });
  });

  it("still partitions the range when nothing is recorded at all", () => {
    const cycles = buildCycleRange("2026-01", "2026-12", []);

    expect(cycles).toHaveLength(12);
    for (let index = 1; index < cycles.length; index += 1) {
      expect(addDays(cycles[index - 1].end, 1)).toBe(cycles[index].payday);
    }
  });

  it("spans multiple years without restarting", () => {
    const cycles = buildCycleRange("2025-11", "2026-02", recorded);

    expect(cycles.map((cycle) => cycle.key)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
});

describe("cycleForDate", () => {
  const cycles = buildCycleRange(
    "2026-01",
    "2026-12",
    SPREADSHEET_COLUMNS.map(([payday, key]) => ({ key, payday })),
  );

  it("puts spend after payday into the month it funds", () => {
    // The case plain calendar-month bucketing gets wrong: 30 July is
    // August's money, because August's salary landed on 25 July.
    expect(cycleForDate("2026-07-30", cycles)?.key).toBe("2026-08");
  });

  it("puts spend before payday into the running cycle", () => {
    expect(cycleForDate("2026-07-24", cycles)?.key).toBe("2026-07");
  });

  it("includes both endpoints", () => {
    expect(cycleForDate("2026-07-25", cycles)?.key).toBe("2026-08");
    expect(cycleForDate("2026-08-26", cycles)?.key).toBe("2026-08");
  });

  it("returns null outside the range", () => {
    expect(cycleForDate("2020-01-01", cycles)).toBeNull();
  });
});

describe("key arithmetic", () => {
  it("walks forward across a year boundary", () => {
    expect(addMonthsToKey("2026-12", 1)).toBe("2027-01");
  });

  it("walks backward across a year boundary", () => {
    expect(addMonthsToKey("2026-01", -1)).toBe("2025-12");
    expect(addMonthsToKey("2026-01", -13)).toBe("2024-12");
  });

  it("measures signed distance between keys", () => {
    expect(monthsBetweenKeys("2026-01", "2026-03")).toBe(2);
    expect(monthsBetweenKeys("2026-03", "2026-01")).toBe(-2);
    expect(monthsBetweenKeys("2025-12", "2026-01")).toBe(1);
  });

  it("crosses month and year ends when adding days", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});
