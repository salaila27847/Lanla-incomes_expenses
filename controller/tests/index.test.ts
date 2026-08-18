/**
 * The full app's wiring, not just one router in isolation: express-async-errors
 * (imported first in src/index.ts) plus the error-handling middleware at the
 * bottom of the middleware chain are what turn a thrown Sheets API error into
 * an actual HTTP response instead of leaving the request hanging forever.
 *
 * This is what silently broke "หักจากบัญชีเงินออม" (the deduct settlement) in
 * production: the real Sheet didn't have a SavingsWithdrawals tab yet (it's
 * new), appendRow threw, and -- with no error handling anywhere in the
 * request path and Express 4 not forwarding async rejections on its own --
 * the request just never answered. The button looked like it did nothing.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function buildRealApp(rowsByRange: Record<string, unknown[][]> = {}) {
  vi.resetModules();
  vi.stubEnv("SHEETS_MOCK_MODE", "false");
  vi.stubEnv("SHEETS_SPREADSHEET_ID", "sheet-123");
  vi.stubEnv("PYTHON_BACKEND_URL", "http://backend.test");

  const { google } = await import("googleapis");
  vi.spyOn(google, "sheets").mockReturnValue({
    spreadsheets: {
      values: {
        get: async ({ range }: { range: string }) => ({ data: { values: rowsByRange[range] ?? [] } }),
        append: async ({ range }: { range: string }) => {
          // Simulates the real-world state this bug needs: a Sheet that
          // predates the SavingsWithdrawals tab this session's feature
          // added. The Sheets API answers a missing tab with a 400 whose
          // message contains this text -- see readOptionalRange's own
          // comment for the read-side equivalent.
          if (range.startsWith("SavingsWithdrawals!")) {
            throw new Error("Unable to parse range: SavingsWithdrawals!A:F");
          }
          return {};
        },
        update: async () => ({}),
      },
    },
  } as unknown as ReturnType<typeof google.sheets>);

  const { default: app } = await import("../src/index");
  return app as unknown as express.Express;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("global error handling", () => {
  it("turns a write that throws into a 500 instead of hanging the request", async () => {
    const app = await buildRealApp({
      "PendingSavings!A2:I": [
        ["p1", "2026-07-28", "", "ตู้เย็น", "goods", "12000", "1", "0", "2026-07-28T00:00:00.000Z"],
      ],
    });

    const response = await request(app).post("/qr/pending/p1/deduct");

    expect(response.status).toBe(500);
    expect(response.body.error).toBeTruthy();
  });

  it("still serves an unrelated route normally", async () => {
    const app = await buildRealApp();

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
