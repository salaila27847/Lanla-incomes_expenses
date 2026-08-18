import { describe, expect, it } from "vitest";
import { groupIncomeByDate } from "../src/pages/SavingsQR";

function entry(id: string, date: string, amount: number) {
  return {
    id,
    date,
    source: `source-${id}`,
    amount,
    destinationAccount: "savings" as const,
  };
}

describe("groupIncomeByDate", () => {
  it("returns nothing for an empty list", () => {
    expect(groupIncomeByDate([])).toEqual([]);
  });

  it("groups consecutive same-date entries together", () => {
    const groups = groupIncomeByDate([
      entry("a", "2026-08-10", 5000),
      entry("b", "2026-08-10", 200),
      entry("c", "2026-08-04", 1000),
    ]);

    expect(groups).toEqual([
      { date: "2026-08-10", entries: [entry("a", "2026-08-10", 5000), entry("b", "2026-08-10", 200)] },
      { date: "2026-08-04", entries: [entry("c", "2026-08-04", 1000)] },
    ]);
  });

  it("preserves the caller's order instead of re-sorting", () => {
    const groups = groupIncomeByDate([entry("a", "2026-08-04", 1000), entry("b", "2026-08-10", 5000)]);

    expect(groups.map((g) => g.date)).toEqual(["2026-08-04", "2026-08-10"]);
  });
});
