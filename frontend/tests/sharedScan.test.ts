import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSharedScan, decodeSharedScanResult } from "../src/sharedScan";

// The controller encodes with Node's Buffer "base64url" — reproduced here
// independently so the test doesn't just round-trip our own decoder.
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("decodeSharedScan — slip", () => {
  it("decodes a Thai payee intact", () => {
    const slip = {
      payee: "ร้านถุงเงิน (แซ่บเล้ง แอนด์ หม่าล่านายเบิร์ด)",
      purchased_at: "2026-10-01",
      amount: 55.5,
      transaction_id: "abc123",
      suggested_store: "ครัวนคร 5",
    };

    expect(decodeSharedScan(encode({ kind: "slip", ...slip }))).toEqual({ kind: "slip", slip });
  });

  it("treats missing optional fields as null", () => {
    expect(decodeSharedScan(encode({ kind: "slip", amount: 120 }))).toEqual({
      kind: "slip",
      slip: {
        payee: null,
        purchased_at: null,
        amount: 120,
        transaction_id: null,
        suggested_store: null,
      },
    });
  });

  it("rejects a slip with no numeric amount", () => {
    expect(decodeSharedScan(encode({ kind: "slip", payee: "x" }))).toBeNull();
    expect(decodeSharedScan(encode({ kind: "slip", amount: "55" }))).toBeNull();
  });
});

describe("decodeSharedScan — receipt", () => {
  const line = {
    id: "1",
    raw_text: "นมสดUHT250ml",
    price: 15,
    quantity: 2,
    discount: 0,
    matched: true,
    master_item_name: "นมสด UHT 250ml",
    category: "food",
    score: 92,
    candidates: [{ name: "นมสด UHT 250ml", score: 92 }],
  };

  it("decodes the lines and receipt fields", () => {
    const decoded = decodeSharedScan(
      encode({
        kind: "receipt",
        store: "7-Eleven",
        suggested_store: null,
        purchased_at: "2026-10-01",
        items: [line],
        bill_discount: 5,
      }),
    );

    expect(decoded).toEqual({
      kind: "receipt",
      receipt: {
        store: "7-Eleven",
        suggested_store: null,
        purchased_at: "2026-10-01",
        items: [line],
        bill_discount: 5,
      },
    });
  });

  it("defaults a line's optional fields", () => {
    const decoded = decodeSharedScan(
      encode({ kind: "receipt", items: [{ raw_text: "ผัก", price: 20 }] }),
    );

    expect(decoded?.kind === "receipt" && decoded.receipt.items[0]).toEqual({
      id: "shared-0",
      raw_text: "ผัก",
      price: 20,
      quantity: 1,
      discount: 0,
      matched: false,
      master_item_name: null,
      category: null,
      score: 0,
      candidates: [],
    });
  });

  it("rejects the whole receipt if any line is malformed, rather than dropping it", () => {
    expect(
      decodeSharedScan(encode({ kind: "receipt", items: [line, { raw_text: "ผัก" }] })),
    ).toBeNull();
    expect(decodeSharedScan(encode({ kind: "receipt" }))).toBeNull();
  });
});

describe("decodeSharedScan — malformed links", () => {
  it("returns null for a missing, mangled or unknown-kind parameter", () => {
    expect(decodeSharedScan(null)).toBeNull();
    expect(decodeSharedScan("")).toBeNull();
    expect(decodeSharedScan("not base64 json!!")).toBeNull();
    expect(decodeSharedScan(encode({ kind: "invoice", amount: 5 }))).toBeNull();
    expect(decodeSharedScan(encode({ amount: 5 }))).toBeNull();
  });
});

describe("decodeSharedScan — independent of the browser's atob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never calls atob, so engine differences can't break a link", () => {
    vi.stubGlobal("atob", () => {
      throw new Error("atob must not be used");
    });
    // Lengths chosen to need 0, 1 and 2 padding characters.
    for (const amount of [1, 12, 123]) {
      expect(decodeSharedScan(encode({ kind: "slip", amount }))).toMatchObject({
        kind: "slip",
        slip: { amount },
      });
    }
  });

  it("decodes Thai text across every padding length", () => {
    for (let n = 0; n < 12; n++) {
      const payee = "ร้าน".repeat(n) + "x".repeat(n % 3);
      const decoded = decodeSharedScan(encode({ kind: "slip", amount: 1, payee }));
      expect(decoded).toMatchObject({ slip: { payee: payee || null } });
    }
  });

  it("accepts the standard alphabet and explicit padding too", () => {
    const standard = Buffer.from(JSON.stringify({ kind: "slip", amount: 7 })).toString("base64");
    expect(decodeSharedScan(standard)).toMatchObject({ slip: { amount: 7 } });
  });
});

describe("decodeSharedScanResult — reasons shown on the phone", () => {
  it("names a bad character and its position", () => {
    const result = decodeSharedScanResult("eyJr!W5k");
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain('"!" ที่ตำแหน่ง 4');
  });

  it("reports a link cut short, with its length", () => {
    const full = encode({ kind: "slip", amount: 55, payee: "ร้านถุงเงิน" });
    const result = decodeSharedScanResult(full.slice(0, 40));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/ไม่ครบ/);
    expect(!result.ok && result.reason).toContain("ความยาวลิงก์ 40");
  });

  it("names the malformed receipt line", () => {
    const result = decodeSharedScanResult(
      encode({ kind: "receipt", items: [{ raw_text: "a", price: 1 }, { raw_text: "b" }] }),
    );
    expect(!result.ok && result.reason).toContain("รายการที่ 2");
  });
});
