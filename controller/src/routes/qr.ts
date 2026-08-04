import { Router } from "express";

export const qrRouter = Router();

const PYTHON_BACKEND_URL = (process.env.PYTHON_BACKEND_URL ?? "http://localhost:8000").trim();

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
