/**
 * Amount parsing for the numeric text boxes.
 *
 * These exist because of a real bug: the price box on the expense screen
 * held a *number* and coerced on every keystroke. `Number("12.")` is `12`,
 * so pressing the decimal point erased it and no price with satang could
 * be entered at all. Clearing the box sprang it back to "0" for the same
 * reason.
 *
 * The fix is that the input holds raw text and parsing happens here — so
 * this is where "still typing" has to stay distinguishable from "zero".
 */
import { describe, expect, it } from "vitest";
import { amountOr0, formatMoney, parseAmount } from "../src/money";

describe("parseAmount", () => {
  it("parses a whole number", () => {
    expect(parseAmount("29")).toBe(29);
  });

  it("parses satang", () => {
    // The case that was impossible to type before.
    expect(parseAmount("12.50")).toBe(12.5);
    expect(parseAmount("6.83")).toBe(6.83);
  });

  it("parses zero, which is a real price", () => {
    // A freebie or a fully discounted line. Must not read as "not a number".
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount("0.00")).toBe(0);
  });

  it("parses a leading decimal point", () => {
    expect(parseAmount(".5")).toBe(0.5);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseAmount("  15 ")).toBe(15);
  });

  it("accepts a trailing decimal point mid-typing", () => {
    // "12." is on the way to "12.50" and is already a valid 12. Refusing
    // it would block saving a price the user has finished typing, and the
    // input is unaffected either way — it holds the raw text, which is
    // what actually fixes the erased decimal point.
    expect(parseAmount("12.")).toBe(12);
  });

  describe("an empty box is null, not zero", () => {
    it.each([["nothing", ""], ["spaces", "   "], ["a bare point", "."]])(
      "%s",
      (_label, text) => {
        // Zero is a price someone might mean; an empty box never is.
        expect(parseAmount(text)).toBeNull();
      },
    );
  });

  describe("rejects what Number() would wrongly accept", () => {
    it.each([
      ["hex", "0x1f"],
      ["exponent", "1e3"],
      ["infinity", "Infinity"],
      ["a newline alone", "\n"],
      ["a negative", "-5"],
      ["a thousands separator", "1,200"],
      ["two decimal points", "1.2.3"],
      ["letters", "ถูกมาก"],
      ["trailing letters", "15บาท"],
    ])("%s", (_label, text) => {
      expect(parseAmount(text)).toBeNull();
    });
  });

  it("never returns a negative", () => {
    // A negative price would subtract from the budget instead of adding.
    for (const text of ["-1", "-0.5", "- 5"]) {
      const parsed = parseAmount(text);
      expect(parsed === null || parsed >= 0).toBe(true);
    }
  });
});

describe("amountOr0", () => {
  it("keeps a running total usable while a line is empty", () => {
    expect(amountOr0("")).toBe(0);
    expect(amountOr0("ถูกมาก")).toBe(0);
  });

  it("passes a real amount straight through", () => {
    expect(amountOr0("12.50")).toBe(12.5);
  });

  it("goes through parseAmount, not Number()", () => {
    // The cases where the two differ, and why it matters: a negative
    // would subtract from the receipt total instead of adding to it, and
    // "1e3" is a typo that would silently become 1,000 baht.
    expect(amountOr0("-5")).toBe(0);
    expect(amountOr0("1e3")).toBe(0);
  });

  it("is not a substitute for the save check", () => {
    // Both read as 0, which is exactly why saving has to use parseAmount:
    // one is a free item, the other is an empty box.
    expect(amountOr0("0")).toBe(amountOr0(""));
    expect(parseAmount("0")).not.toBe(parseAmount(""));
  });
});

describe("formatMoney", () => {
  it("always shows satang", () => {
    expect(formatMoney(15)).toBe("15.00");
    expect(formatMoney(12.5)).toBe("12.50");
  });

  it("groups thousands", () => {
    expect(formatMoney(56930.42)).toBe("56,930.42");
  });

  it("rounds to two places rather than running long", () => {
    // 41 / 6 — a line total that doesn't divide evenly by its quantity.
    expect(formatMoney(41 / 6)).toBe("6.83");
  });
});
