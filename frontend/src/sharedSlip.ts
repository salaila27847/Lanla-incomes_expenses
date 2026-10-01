/**
 * Decodes the `?slip=` parameter an iOS Shortcut opens the app with.
 *
 * iOS Safari doesn't support the Web Share Target API, so the PWA can't be
 * a share-sheet destination itself. Instead a Shortcut uploads the slip to
 * the controller's /receipt/share-slip, which scans it and returns a link
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function decodeSharedSlip(param: string | null): SharedSlip | null {
  if (!param) return null;
  try {
    const base64 = param.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return null;
    const slip = parsed as Record<string, unknown>;
    if (typeof slip.amount !== "number" || !Number.isFinite(slip.amount)) return null;
    return {
      payee: optionalString(slip.payee),
      purchased_at: optionalString(slip.purchased_at),
      amount: slip.amount,
      transaction_id: optionalString(slip.transaction_id),
      suggested_store: optionalString(slip.suggested_store),
    };
  } catch {
    return null;
  }
}
