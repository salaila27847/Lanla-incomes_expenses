import { Router } from "express";
import multer from "multer";

export const receiptRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

receiptRouter.post("/", upload.single("image"), async (_req, res) => {
  // TODO: forward the uploaded image to the Python backend's POST /ocr,
  // then POST /match for each detected line against the master item
  // list, return the reviewable result to the PWA, and once the user
  // confirms it, write the final rows to Google Sheets via appendRow().
  res.status(501).json({ error: "Receipt processing not implemented yet" });
});
