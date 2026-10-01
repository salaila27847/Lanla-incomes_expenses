import { describe, expect, it } from "vitest";
import { decodeSharedSlip } from "../src/sharedSlip";

// The controller encodes with Node's Buffer "base64url" — reproduced here
// independently so the test doesn't just round-trip our own decoder.
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("decodeSharedSlip", () => {
  it("decodes a Thai payee intact", () => {
    const slip = {
      payee: "ร้านถุงเงิน (แซ่บเล้ง แอนด์ หม่าล่านายเบิร์ด)",
      purchased_at: "2026-10-01",
      amount: 55.5,
      transaction_id: "abc123",
      suggested_store: "ครัวนคร 5",
    };

    expect(decodeSharedSlip(encode(slip))).toEqual(slip);
  });

  it("treats missing optional fields as null", () => {
    expect(decodeSharedSlip(encode({ amount: 120 }))).toEqual({
      payee: null,
      purchased_at: null,
      amount: 120,
      transaction_id: null,
      suggested_store: null,
    });
  });

  it("returns null for a missing, mangled or amount-less parameter", () => {
    expect(decodeSharedSlip(null)).toBeNull();
    expect(decodeSharedSlip("")).toBeNull();
    expect(decodeSharedSlip("not base64 json!!")).toBeNull();
    expect(decodeSharedSlip(encode({ payee: "x" }))).toBeNull();
    expect(decodeSharedSlip(encode({ amount: "55" }))).toBeNull();
  });
});
