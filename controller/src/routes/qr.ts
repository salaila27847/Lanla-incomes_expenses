import { Router } from "express";
import { env } from "../env";
import {
  appendMasterItem,
  appendPriceHistoryRow,
  deletePendingSavingsItem,
  readMasterItems,
  readPendingSavingsItems,
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

qrRouter.post("/pending/:id/confirm", async (req, res) => {
  const pending = (await readPendingSavingsItems()).find((item) => item.id === req.params.id);
  if (!pending) {
    res.status(404).json({ error: "pending savings item not found" });
    return;
  }

  const existingNames = new Set((await readMasterItems()).map((mi) => mi.name));
  if (!existingNames.has(pending.masterItemName)) {
    await appendMasterItem(pending.masterItemName, pending.category);
  }
  // The item's own purchase date, not today — a purchase made near the
  // end of a cycle but confirmed later must stay in the cycle it was
  // actually bought in, or it silently jumps to the wrong column.
  await appendPriceHistoryRow({
    date: pending.date,
    store: pending.store,
    masterItemName: pending.masterItemName,
    category: pending.category,
    price: pending.price,
    quantity: pending.quantity,
    discount: pending.discount,
  });
  await deletePendingSavingsItem(pending.id);

  res.json({ success: true, id: pending.id });
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
