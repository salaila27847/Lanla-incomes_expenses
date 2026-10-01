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

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * base64url → bytes without the browser's atob, so the result doesn't
 * depend on how a given engine treats missing padding or the url-safe
 * alphabet. Throws naming the first bad character, for the error message.
 */
function base64UrlToBytes(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    // Standard-alphabet characters too, in case anything converted it.
    const char = clean[i] === "+" ? "-" : clean[i] === "/" ? "_" : clean[i];
    const value = BASE64URL.indexOf(char);
    if (value === -1) {
      throw new Error(`ตัวอักษรไม่ถูกต้อง "${clean[i]}" ที่ตำแหน่ง ${i}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export type SharedScanResult = { ok: true; scan: SharedScan } | { ok: false; reason: string };

/**
 * Like decodeSharedScan, but says why a link was rejected. A shared link
 * only fails on the phone, where there are no dev tools — the reason (and
 * the link's length, which shows truncation) is shown on screen instead.
 */
export function decodeSharedScanResult(param: string | null): SharedScanResult {
  const fail = (reason: string): SharedScanResult => ({
    ok: false,
    reason: `${reason} (ความยาวลิงก์ ${param?.length ?? 0})`,
  });
  if (!param) return fail("ไม่มีข้อมูลในลิงก์");

  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(param);
  } catch (error) {
    return fail(`ถอดรหัสไม่ได้: ${error instanceof Error ? error.message : String(error)}`);
  }
  let text: string;
  try {
    // fatal: a link cut off mid-character fails here instead of decoding
    // to garbage that then fails JSON.parse with a less useful message.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("ข้อความในลิงก์ไม่ครบ (UTF-8)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail(`ข้อมูลในลิงก์ไม่ครบ (JSON: ${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof parsed !== "object" || parsed === null) return fail("ข้อมูลไม่ใช่ object");
  const scan = parsed as Record<string, unknown>;

  if (scan.kind === "slip") {
    if (!finiteNumber(scan.amount)) return fail("สลิปไม่มียอดเงิน");
    return {
      ok: true,
      scan: {
        kind: "slip",
        slip: {
          payee: optionalString(scan.payee),
          purchased_at: optionalString(scan.purchased_at),
          amount: scan.amount,
          transaction_id: optionalString(scan.transaction_id),
          suggested_store: optionalString(scan.suggested_store),
        },
      },
    };
  }

  if (scan.kind === "receipt") {
    if (!Array.isArray(scan.items)) return fail("ใบเสร็จไม่มีรายการ");
    const items = scan.items.map(receiptItem);
    // One malformed line means the link was tampered with or truncated;
    // half a receipt is worse than none, since the missing lines are silent.
    const bad = items.findIndex((item) => item === null);
    if (bad !== -1) return fail(`รายการที่ ${bad + 1} ข้อมูลไม่ครบ`);
    return {
      ok: true,
      scan: {
        kind: "receipt",
        receipt: {
          store: optionalString(scan.store),
          suggested_store: optionalString(scan.suggested_store),
          purchased_at: optionalString(scan.purchased_at),
          items: items as SharedReceiptItem[],
          bill_discount: finiteNumber(scan.bill_discount) ? scan.bill_discount : 0,
        },
      },
    };
  }

  return fail(`ไม่รู้จักชนิด "${String(scan.kind)}"`);
}

export function decodeSharedScan(param: string | null): SharedScan | null {
  const result = decodeSharedScanResult(param);
  return result.ok ? result.scan : null;
}
