/**
 * Parsing for amounts typed into a text box.
 *
 * The rule these exist to enforce: a controlled numeric input must hold the
 * raw string the user typed, never a number. Coercing on every keystroke
 * makes half-typed values unrepresentable — `Number("12.")` is `12`, so the
 * decimal point is erased the moment it's pressed and a price like 12.50
 * can't be entered at all. Clearing the box has the same problem:
 * `Number("")` is 0, so the field springs back to "0" instead of going
 * empty.
 */

/**
 * A non-negative amount, or null if the text isn't one yet.
 *
 * Null means "no amount here yet" — an empty box, or text that isn't a
 * number. Zero is not null: someone may genuinely mean a free item, and
 * collapsing the two is how an empty box would silently save as 0.
 *
 * A trailing point ("12.") parses as 12. It is on the way to "12.50" but
 * is already a valid amount, and refusing it would block saving a price
 * that is finished.
 */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Number() accepts things no one means as a price: "0x1f", "1e3",
  // "Infinity", and (as whitespace) "\n". Match the shape first.
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** The parsed amount, or 0 while the text isn't a usable number yet — for
 *  running totals, where a half-typed line shouldn't break the sum. */
export function amountOr0(text: string): number {
  return parseAmount(text) ?? 0;
}

export function formatMoney(value: number): string {
  return value.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
