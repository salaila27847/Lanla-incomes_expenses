import { describe, expect, it } from "vitest";
import { buildSavingsMovements, groupMovementsByDate, pendingTotalsByCategory } from "../src/pages/SavingsQR";

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

function pendingItem(
  id: string,
  category: "food" | "goods",
  price: number,
  { quantity = 1, discount = 0 }: { quantity?: number; discount?: number } = {},
) {
  return {
    id,
    date: "2026-08-10",
    store: null,
    masterItemName: `item-${id}`,
    category,
    price,
    quantity,
    discount,
    createdAt: "2026-08-10T00:00:00.000Z",
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
      { id: "income-a", sourceId: "a", date: "2026-08-10", label: "source-a", amount: 5000, direction: "in" },
      { id: "withdrawal-b", sourceId: "b", date: "2026-08-04", label: "item-b", amount: 200, direction: "out" },
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
          { id: "income-a", sourceId: "a", date: "2026-08-10", label: "source-a", amount: 5000, direction: "in" },
          { id: "withdrawal-b", sourceId: "b", date: "2026-08-10", label: "item-b", amount: 200, direction: "out" },
        ],
      },
      {
        date: "2026-08-04",
        movements: [
          { id: "withdrawal-c", sourceId: "c", date: "2026-08-04", label: "item-c", amount: 1000, direction: "out" },
        ],
      },
    ]);
  });
});

describe("pendingTotalsByCategory", () => {
  it("returns nothing for an empty list", () => {
    expect(pendingTotalsByCategory([])).toEqual([]);
  });

  it("sums line totals within a category", () => {
    const items = [
      pendingItem("a", "food", 194.25),
      pendingItem("b", "food", 162, { quantity: 6 }),
    ];

    expect(pendingTotalsByCategory(items)).toEqual([{ category: "food", total: 1166.25 }]);
  });

  it("keeps food and goods apart, food first", () => {
    const items = [pendingItem("a", "goods", 89), pendingItem("b", "food", 120)];

    expect(pendingTotalsByCategory(items)).toEqual([
      { category: "food", total: 120 },
      { category: "goods", total: 89 },
    ]);
  });

  it("nets a bill-level discount into its own category's total", () => {
    const items = [pendingItem("a", "food", 120), pendingItem("b", "food", 0, { discount: 33 })];

    expect(pendingTotalsByCategory(items)).toEqual([{ category: "food", total: 87 }]);
  });

  it("omits a category with no pending items", () => {
    const items = [pendingItem("a", "food", 120)];

    expect(pendingTotalsByCategory(items).map((t) => t.category)).toEqual(["food"]);
  });
});
