import { Router } from "express";

export const qrRouter = Router();

qrRouter.post("/", async (_req, res) => {
  // TODO: proxy the request body ({ amount_thb, promptpay_id }) to the
  // Python backend's POST /qr and return its response to the PWA as-is.
  res.status(501).json({ error: "QR generation not implemented yet" });
});
