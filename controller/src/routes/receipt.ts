import { Router } from "express";
import multer from "multer";
import {
  appendMasterItem,
  appendPriceHistoryRow,
  readMasterItems,
  type ItemCategory,
} from "../sheets/client";

export const receiptRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL ?? "http://localhost:8000";

interface OcrItem {
  id: string;
  raw_text: string;
  price: number;
}

interface OcrResponse {
  store: string | null;
  purchased_at: string | null;
  items: OcrItem[];
}

interface MatchResponse {
  matched: boolean;
  master_item_name: string | null;
  score: number;
}

interface ScanResponseItem extends OcrItem {
  matched: boolean;
  master_item_name: string | null;
  category: ItemCategory | null;
  score: number;
}

// Scan: OCR the receipt, then fuzzy-match every line against the current
// master item list, and hand the annotated result to the PWA for review.
// Nothing is written to Sheets yet — that happens on /confirm.
receiptRouter.post("/scan", upload.single("image"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "image file is required" });
    return;
  }

  const ocrForm = new FormData();
  // Buffer's ArrayBufferLike can be a SharedArrayBuffer, which BlobPart
  // doesn't accept; copying into a plain Uint8Array sidesteps that.
  ocrForm.append(
    "image",
    new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype }),
    req.file.originalname,
  );

  const ocrResponse = await fetch(`${PYTHON_BACKEND_URL}/ocr/`, {
    method: "POST",
    body: ocrForm,
  });
  if (!ocrResponse.ok) {
    res.status(502).json({ error: `OCR backend returned ${ocrResponse.status}` });
    return;
  }
  const ocrResult = (await ocrResponse.json()) as OcrResponse;

  const masterItems = await readMasterItems();
  const candidateNames = masterItems.map((item) => item.name);

  const items: ScanResponseItem[] = await Promise.all(
    ocrResult.items.map(async (item): Promise<ScanResponseItem> => {
      const matchResponse = await fetch(`${PYTHON_BACKEND_URL}/match/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_text: item.raw_text,
          candidate_master_items: candidateNames,
        }),
      });
      if (!matchResponse.ok) {
        return { ...item, matched: false, master_item_name: null, category: null, score: 0 };
      }
      const match = (await matchResponse.json()) as MatchResponse;
      const category = match.matched
        ? (masterItems.find((mi) => mi.name === match.master_item_name)?.category ?? null)
        : null;
      return { ...item, ...match, category };
    }),
  );

  res.json({ store: ocrResult.store, purchased_at: ocrResult.purchased_at, items });
});

interface ConfirmedItem {
  raw_text: string;
  price: number;
  master_item_name: string;
  category: ItemCategory;
}

interface ConfirmRequestBody {
  store: string | null;
  purchased_at: string | null;
  items: ConfirmedItem[];
}

// Confirm: the user has reviewed every line (matched or freshly named),
// picked a category for each, and is saving the receipt. Any master item
// name that isn't already in the list gets created; every line becomes a
// PriceHistory row.
receiptRouter.post("/confirm", async (req, res) => {
  const { store, purchased_at, items } = req.body as ConfirmRequestBody;

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items must be a non-empty array" });
    return;
  }
  for (const item of items) {
    if (!item.master_item_name || !item.category) {
      res.status(400).json({ error: "every item needs master_item_name and category" });
      return;
    }
  }

  const existingNames = new Set((await readMasterItems()).map((mi) => mi.name));
  let newMasterItems = 0;
  const date = purchased_at ?? new Date().toISOString().slice(0, 10);

  for (const item of items) {
    if (!existingNames.has(item.master_item_name)) {
      await appendMasterItem(item.master_item_name, item.category);
      existingNames.add(item.master_item_name);
      newMasterItems += 1;
    }
    await appendPriceHistoryRow({
      date,
      store: store ?? null,
      masterItemName: item.master_item_name,
      category: item.category,
      price: item.price,
    });
  }

  res.json({
    success: true,
    new_master_items_added: newMasterItems,
    price_history_rows_written: items.length,
  });
});
