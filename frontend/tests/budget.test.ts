import { describe, expect, it } from "vitest";
import { groupExpensesByDate } from "../src/pages/Budget";

function expense(id: string, date: string) {
  return {
    id,
    date,
    store: null,
    masterItemName: `item-${id}`,
    category: "food" as const,
    price: 10,
    quantity: 1,
    discount: 0,
  };
}

describe("groupExpensesByDate", () => {
  it("returns nothing for an empty list", () => {
    expect(groupExpensesByDate([])).toEqual([]);
  });

  it("groups consecutive same-date rows together", () => {
    const groups = groupExpensesByDate([
      expense("a", "2026-08-06"),
      expense("b", "2026-08-06"),
      expense("c", "2026-08-04"),
    ]);

    expect(groups).toEqual([
      { date: "2026-08-06", items: [expense("a", "2026-08-06"), expense("b", "2026-08-06")] },
      { date: "2026-08-04", items: [expense("c", "2026-08-04")] },
    ]);
  });

  it("preserves the caller's order instead of re-sorting", () => {
    // /expenses already returns newest date first; grouping must not
    // second-guess that ordering.
    const groups = groupExpensesByDate([
      expense("a", "2026-08-04"),
      expense("b", "2026-08-06"),
    ]);

    expect(groups.map((g) => g.date)).toEqual(["2026-08-04", "2026-08-06"]);
  });

  it("keeps two same-date rows separate when another date sits between them", () => {
    // Only *consecutive* rows merge -- a repeated date after a gap is its
    // own group, not silently folded into the earlier one.
    const groups = groupExpensesByDate([
      expense("a", "2026-08-06"),
      expense("b", "2026-08-05"),
      expense("c", "2026-08-06"),
    ]);

    expect(groups).toEqual([
      { date: "2026-08-06", items: [expense("a", "2026-08-06")] },
      { date: "2026-08-05", items: [expense("b", "2026-08-05")] },
      { date: "2026-08-06", items: [expense("c", "2026-08-06")] },
    ]);
  });
});
