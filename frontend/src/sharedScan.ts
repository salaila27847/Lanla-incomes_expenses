/**
 * Decodes the `?shared=` parameter an iOS Shortcut opens the app with.
 *
 * iOS Safari doesn't support the Web Share Target API, so the PWA can't be
 * a share-sheet destination itself. Instead a Shortcut uploads the image to
 * the controller's /receipt/share, which scans it and returns a link
 * carrying the result as base64url-encoded JSON — nothing is stored
 * server-side, so the link is the only place the result lives.
 *
 * Returns null for anything that isn't a well-formed result rather than
 * throwing: a mangled link should land on the normal scan page, not crash it.
 */
export interface SharedSlip {
  payee: string | null;
  purchased_at: string | null;
  amount: number;
  transaction_id: string | null;
  suggested_store: string | null;
}

export interface SharedReceiptItem {
  id: string;
  raw_text: string;
  price: number;
  quantity: number;
  discount: number;
  matched: boolean;
  master_item_name: string | null;
  category: "food" | "goods" | null;
  score: number;
  candidates: { name: string; score: number }[];
}

export interface SharedReceipt {
  store: string | null;
  suggested_store: string | null;
  purchased_at: string | null;
  items: SharedReceiptItem[];
  bill_discount: number;
}

export type SharedScan =
  | { kind: "slip"; slip: SharedSlip }
  | { kind: "receipt"; receipt: SharedReceipt };

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function receiptItem(value: unknown, index: number): SharedReceiptItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.raw_text !== "string" || !finiteNumber(item.price)) return null;
  const candidates = Array.isArray(item.candidates)
    ? item.candidates.filter(
        (c): c is { name: string; score: number } =>
          typeof c === "object" && c !== null && typeof c.name === "string" && finiteNumber(c.score),
      )
    : [];
  return {
    id: optionalString(item.id) ?? `shared-${index}`,
    raw_text: item.raw_text,
    price: item.price,
    quantity: finiteNumber(item.quantity) && item.quantity > 0 ? item.quantity : 1,
    discount: finiteNumber(item.discount) ? item.discount : 0,
    matched: item.matched === true,
    master_item_name: optionalString(item.master_item_name),
    category: item.category === "food" || item.category === "goods" ? item.category : null,
    score: finiteNumber(item.score) ? item.score : 0,
    candidates,
  };
}

export function decodeSharedScan(param: string | null): SharedScan | null {
  if (!param) return null;
  let parsed: unknown;
  try {
    const base64 = param.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const scan = parsed as Record<string, unknown>;

  if (scan.kind === "slip") {
    if (!finiteNumber(scan.amount)) return null;
    return {
      kind: "slip",
      slip: {
        payee: optionalString(scan.payee),
        purchased_at: optionalString(scan.purchased_at),
        amount: scan.amount,
        transaction_id: optionalString(scan.transaction_id),
        suggested_store: optionalString(scan.suggested_store),
      },
    };
  }

  if (scan.kind === "receipt") {
    if (!Array.isArray(scan.items)) return null;
    const items = scan.items.map(receiptItem);
    // One malformed line means the link was tampered with or truncated;
    // half a receipt is worse than none, since the missing lines are silent.
    if (items.some((item) => item === null)) return null;
    return {
      kind: "receipt",
      receipt: {
        store: optionalString(scan.store),
        suggested_store: optionalString(scan.suggested_store),
        purchased_at: optionalString(scan.purchased_at),
        items: items as SharedReceiptItem[],
        bill_discount: finiteNumber(scan.bill_discount) ? scan.bill_discount : 0,
      },
    };
  }

  return null;
}
