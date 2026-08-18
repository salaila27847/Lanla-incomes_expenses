import { describe, expect, it } from "vitest";
import { buildSavingsMovements, groupMovementsByDate } from "../src/pages/SavingsQR";

function income(id: string, date: string, amount: number) {
  return {
    id,
    date,
    source: `source-${id}`,
    amount,
    destinationAccount: "savings" as const,
  };
}

function withdrawal(id: string, date: string, amount: number) {
  return {
    id,
    date,
    masterItemName: `item-${id}`,
    category: "goods" as const,
    amount,
    confirmedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("buildSavingsMovements", () => {
  it("returns nothing for two empty lists", () => {
    expect(buildSavingsMovements([], [])).toEqual([]);
  });

  it("tags income as in and withdrawals as out", () => {
    const movements = buildSavingsMovements([income("a", "2026-08-10", 5000)], [
      withdrawal("b", "2026-08-04", 200),
    ]);

    expect(movements).toEqual([
      { id: "income-a", date: "2026-08-10", label: "source-a", amount: 5000, direction: "in" },
      { id: "withdrawal-b", date: "2026-08-04", label: "item-b", amount: 200, direction: "out" },
    ]);
  });

  it("merges both into one newest-first timeline", () => {
    const movements = buildSavingsMovements(
      [income("a", "2026-08-04", 1000)],
      [withdrawal("b", "2026-08-10", 200)],
    );

    expect(movements.map((m) => m.id)).toEqual(["withdrawal-b", "income-a"]);
  });
});

describe("groupMovementsByDate", () => {
  it("returns nothing for an empty list", () => {
    expect(groupMovementsByDate([])).toEqual([]);
  });

  it("groups consecutive same-date movements together, in vs out included", () => {
    const groups = groupMovementsByDate(
      buildSavingsMovements(
        [income("a", "2026-08-10", 5000)],
        [withdrawal("b", "2026-08-10", 200), withdrawal("c", "2026-08-04", 1000)],
      ),
    );

    expect(groups).toEqual([
      {
        date: "2026-08-10",
        movements: [
          { id: "income-a", date: "2026-08-10", label: "source-a", amount: 5000, direction: "in" },
          { id: "withdrawal-b", date: "2026-08-10", label: "item-b", amount: 200, direction: "out" },
        ],
      },
      {
        date: "2026-08-04",
        movements: [
          { id: "withdrawal-c", date: "2026-08-04", label: "item-c", amount: 1000, direction: "out" },
        ],
      },
    ]);
  });
});
