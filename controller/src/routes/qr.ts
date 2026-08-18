import { Router } from "express";
import { cycleContaining, loadCycles } from "../cycleService";
import { isCycleKey } from "../cycles";
import { env } from "../env";
import {
  appendMasterItem,
  appendPriceHistoryRow,
  appendSavingsWithdrawal,
  deletePendingSavingsItem,
  lineTotal,
  readCycleRows,
  readMasterItems,
  readPendingSavingsItems,
  readSavingsWithdrawals,
  upsertCycleRow,
} from "../sheets/client";

export const qrRouter = Router();

const PYTHON_BACKEND_URL = env("PYTHON_BACKEND_URL", "http://localhost:8000");

// Thin proxy: the PromptPay ID is a backend-only secret (SAVINGS_PROMPTPAY_ID),
// so the PWA only ever sends an amount.
qrRouter.post("/", async (req, res) => {
  const { amount_thb } = req.body as { amount_thb?: number };
  if (typeof amount_thb !== "number" || amount_thb <= 0) {
    res.status(400).json({ error: "amount_thb must be a positive number" });
    return;
  }

  const backendResponse = await fetch(`${PYTHON_BACKEND_URL}/qr/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount_thb }),
  });
  const body = await backendResponse.json();
  res.status(backendResponse.status).json(body);
});

// Lines paid straight from the savings account (paid_from: "savings" on
// /receipt/confirm) land here instead of PriceHistory, waiting for the
// transfer-back QR to actually be sent.
qrRouter.get("/pending", async (_req, res) => {
  res.json({ items: await readPendingSavingsItems() });
});

/** Shared by both settlement paths below: a pending line always becomes a
 *  real PriceHistory row (same price-history value regardless of which
 *  account ends up bearing the cost), using the item's own purchase date
 *  rather than today's — a purchase made near the end of a cycle but
 *  settled later must stay in the cycle it was actually bought in, or it
 *  silently jumps to the wrong column. */
async function settlePendingIntoPriceHistory(pending: {
  date: string;
  store: string | null;
  masterItemName: string;
  category: "food" | "goods";
  price: number;
  quantity: number;
  discount: number;
}): Promise<void> {
  const existingNames = new Set((await readMasterItems()).map((mi) => mi.name));
  if (!existingNames.has(pending.masterItemName)) {
    await appendMasterItem(pending.masterItemName, pending.category);
  }
  await appendPriceHistoryRow({
    date: pending.date,
    store: pending.store,
    masterItemName: pending.masterItemName,
    category: pending.category,
    price: pending.price,
    quantity: pending.quantity,
    discount: pending.discount,
  });
}

// The spending account pays the savings account back for this line — the
// QR above is what sends that transfer. Net effect on the savings balance
// is zero (it fronted the purchase, then got reimbursed), so there's
// nothing to log for the Savings tab's movement list beyond the
// PriceHistory row every settlement path writes.
qrRouter.post("/pending/:id/confirm", async (req, res) => {
  const pending = (await readPendingSavingsItems()).find((item) => item.id === req.params.id);
  if (!pending) {
    res.status(404).json({ error: "pending savings item not found" });
    return;
  }

  await settlePendingIntoPriceHistory(pending);
  await deletePendingSavingsItem(pending.id);

  res.json({ success: true, id: pending.id });
});

// The savings account keeps the cost instead of being reimbursed -- a
// deliberate, permanent drawdown (a big item actually saved up for), not
// money temporarily fronted. Unlike a savings-tagged Income deposit, this
// is the one place money leaves the account by a route the app knows
// about, so it's safe to apply the decrement immediately rather than
// waiting for the next hand-typed SavingsBalance correction.
qrRouter.post("/pending/:id/deduct", async (req, res) => {
  const pending = (await readPendingSavingsItems()).find((item) => item.id === req.params.id);
  if (!pending) {
    res.status(404).json({ error: "pending savings item not found" });
    return;
  }

  const amount = lineTotal(pending);
  await settlePendingIntoPriceHistory(pending);
  await appendSavingsWithdrawal({
    date: pending.date,
    masterItemName: pending.masterItemName,
    category: pending.category,
    amount,
  });

  const cycle = await cycleContaining(pending.date);
  if (cycle) {
    const existing = (await readCycleRows()).find((row) => row.key === cycle.key);
    await upsertCycleRow({
      key: cycle.key,
      savingsBalance: (existing?.savingsBalance ?? 0) - amount,
    });
  }

  await deletePendingSavingsItem(pending.id);

  res.json({ success: true, id: pending.id });
});

// This cycle's confirmed-as-permanent savings drawdowns, for the Savings
// tab's movement list -- the "out" half, alongside savings-tagged Income
// entries as the "in" half.
qrRouter.get("/withdrawals", async (req, res) => {
  const cycleKey = typeof req.query.cycle === "string" ? req.query.cycle : null;
  const withdrawals = await readSavingsWithdrawals();

  if (!cycleKey) {
    res.json({ withdrawals: [...withdrawals].sort((a, b) => b.date.localeCompare(a.date)) });
    return;
  }
  if (!isCycleKey(cycleKey)) {
    res.status(400).json({ error: "cycle must look like YYYY-MM" });
    return;
  }

  const [cycle] = await loadCycles(cycleKey, cycleKey);
  res.json({
    cycle,
    withdrawals: withdrawals
      .filter((row) => row.date >= cycle.payday && row.date <= cycle.end)
      .sort((a, b) => b.date.localeCompare(a.date)),
  });
});

// Backing out of a mistaken "pay with savings" tap — the item goes away
// rather than sitting in the pending list forever with no way to fix it.
qrRouter.delete("/pending/:id", async (req, res) => {
  if (!(await deletePendingSavingsItem(req.params.id))) {
    res.status(404).json({ error: "pending savings item not found" });
    return;
  }
  res.json({ success: true, id: req.params.id });
});
