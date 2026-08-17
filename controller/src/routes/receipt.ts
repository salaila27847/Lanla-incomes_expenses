import { Router } from "express";
import multer from "multer";
import { env } from "../env";
import {
  appendMasterItem,
  appendPendingSavingsItem,
  appendPriceHistoryRow,
  findStoreForPayee,
  lineTotal,
  readMasterItems,
  upsertSlipPayeeMapping,
  type ItemCategory,
} from "../sheets/client";

export const receiptRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

const PYTHON_BACKEND_URL = env("PYTHON_BACKEND_URL", "http://localhost:8000");

interface OcrItem {
  id: string;
  raw_text: string;
  /** Per unit, before discount; the backend already divided by quantity. */
  price: number;
  quantity: number;
  /** Taken off this line as a whole. */
  discount: number;
}

interface OcrResponse {
  store: string | null;
  purchased_at: string | null;
  items: OcrItem[];
  /** An amount off the whole receipt that no single line accounts for.
   *  Becomes its own line for the user to categorise. */
  bill_discount: number;
}

interface MatchCandidate {
  name: string;
  score: number;
}

interface MatchResponse {
  matched: boolean;
  master_item_name: string | null;
  score: number;
  candidates: MatchCandidate[];
}

interface ScanResponseItem extends OcrItem {
  /** True only when the top candidate scored high enough to pre-select.
   *  Otherwise the frontend shows `candidates` and waits for a tap. */
  matched: boolean;
  master_item_name: string | null;
  category: ItemCategory | null;
  score: number;
  candidates: MatchCandidate[];
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

  // fetch rejects rather than resolving when the backend isn't reachable
  // at all, and an unhandled rejection here took the whole controller down
  // in local dev. Naming the URL matters too: "502" alone sent us round a
  // long debugging loop once already.
  let ocrResponse: Response;
  try {
    ocrResponse = await fetch(`${PYTHON_BACKEND_URL}/ocr/`, { method: "POST", body: ocrForm });
  } catch (error) {
    res.status(502).json({
      error: `OCR backend unreachable at ${PYTHON_BACKEND_URL}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return;
  }
  if (!ocrResponse.ok) {
    res.status(502).json({ error: `OCR backend returned ${ocrResponse.status}` });
    return;
  }
  const ocrResult = (await ocrResponse.json()) as OcrResponse;

  const masterItems = await readMasterItems();
  const candidateNames = masterItems.map((item) => item.name);

  const items: ScanResponseItem[] = await Promise.all(
    ocrResult.items.map(async (item): Promise<ScanResponseItem> => {
      // A matching failure is survivable in a way an OCR failure isn't:
      // the line still has its text and price, and "pick it yourself" is
      // now a first-class path rather than a dead end.
      const unmatched: ScanResponseItem = {
        ...item,
        matched: false,
        master_item_name: null,
        category: null,
        score: 0,
        candidates: [],
      };

      let matchResponse: Response;
      try {
        matchResponse = await fetch(`${PYTHON_BACKEND_URL}/match/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            raw_text: item.raw_text,
            candidate_master_items: candidateNames,
          }),
        });
      } catch {
        return unmatched;
      }
      if (!matchResponse.ok) {
        return unmatched;
      }
      const match = (await matchResponse.json()) as MatchResponse;
      const category = match.matched
        ? (masterItems.find((mi) => mi.name === match.master_item_name)?.category ?? null)
        : null;
      return { ...item, ...match, candidates: match.candidates ?? [], category };
    }),
  );

  // The full list rides along so the picker can offer every master item
  // without a second round trip — they're already read above.
  res.json({
    store: ocrResult.store,
    purchased_at: ocrResult.purchased_at,
    items,
    bill_discount: ocrResult.bill_discount ?? 0,
    master_items: masterItems,
  });
});

/** The master item list on its own, for the manual-entry form. */
receiptRouter.get("/master-items", async (_req, res) => {
  res.json({ master_items: await readMasterItems() });
});

interface SlipOcrResponse {
  payee: string | null;
  purchased_at: string | null;
  amount: number;
  transaction_id: string | null;
}

// Scan-slip: OCR a bank transfer slip. Unlike /scan there are no line
// items to match -- a transfer slip only says who was paid, when, and how
// much -- so the PWA falls into its manual-entry UI afterwards, pre-filled
// with the slip's own date and a target total the entered lines have to
// add up to. `suggested_store` is filled in when this payee has been
// mapped to a store name before (see upsertSlipPayeeMapping on /confirm).
receiptRouter.post("/scan-slip", upload.single("image"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "image file is required" });
    return;
  }

  const ocrForm = new FormData();
  ocrForm.append(
    "image",
    new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype }),
    req.file.originalname,
  );

  let ocrResponse: Response;
  try {
    ocrResponse = await fetch(`${PYTHON_BACKEND_URL}/ocr/slip`, { method: "POST", body: ocrForm });
  } catch (error) {
    res.status(502).json({
      error: `OCR backend unreachable at ${PYTHON_BACKEND_URL}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return;
  }
  if (!ocrResponse.ok) {
    res.status(502).json({ error: `OCR backend returned ${ocrResponse.status}` });
    return;
  }
  const slip = (await ocrResponse.json()) as SlipOcrResponse;

  res.json({
    ...slip,
    suggested_store: slip.payee ? await findStoreForPayee(slip.payee) : null,
  });
});

interface ConfirmedItem {
  raw_text: string;
  price: number;
  quantity?: number;
  discount?: number;
  master_item_name: string;
  category: ItemCategory;
  /** Which account the money actually came out of. Defaults to "spending"
   *  so every caller that predates this field keeps behaving exactly as
   *  before. A "savings" line isn't a recorded expense yet — see the note
   *  on PendingSavingsItem in sheets/client.ts. */
  paid_from?: "spending" | "savings";
}

interface ConfirmRequestBody {
  store: string | null;
  purchased_at: string | null;
  items: ConfirmedItem[];
  /** Present only when this receipt came from a transfer-slip scan: what
   *  the slip itself said was paid. Lets /confirm check the entered items
   *  actually add up to the real transfer before writing anything, and
   *  remember which store this payee maps to for next time. */
  slip?: { payee: string | null; amount: number };
}

// Confirm: the user has reviewed every line (matched or freshly named),
// picked a category for each, and is saving the receipt. Any master item
// name that isn't already in the list gets created; every line becomes a
// PriceHistory row.
receiptRouter.post("/confirm", async (req, res) => {
  const { store, purchased_at, items, slip } = req.body as ConfirmRequestBody;

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
  if (slip) {
    const total = items.reduce(
      (sum, item) =>
        sum + lineTotal({ price: item.price, quantity: item.quantity ?? 1, discount: item.discount ?? 0 }),
      0,
    );
    // Off by a fraction of a satang is float noise, not a real mismatch.
    if (Math.round((total - slip.amount) * 100) !== 0) {
      res.status(400).json({
        error: `entered items total ${total.toFixed(2)} but the slip transferred ${slip.amount.toFixed(2)}`,
      });
      return;
    }
  }

  const existingNames = new Set((await readMasterItems()).map((mi) => mi.name));
  let newMasterItems = 0;
  let priceHistoryRowsWritten = 0;
  let pendingSavingsRowsWritten = 0;
  const date = purchased_at ?? new Date().toISOString().slice(0, 10);

  for (const item of items) {
    if (!existingNames.has(item.master_item_name)) {
      await appendMasterItem(item.master_item_name, item.category);
      existingNames.add(item.master_item_name);
      newMasterItems += 1;
    }
    const row = {
      date,
      store: store ?? null,
      masterItemName: item.master_item_name,
      category: item.category,
      price: item.price,
      quantity: item.quantity ?? 1,
      discount: item.discount ?? 0,
    };
    if (item.paid_from === "savings") {
      // Held here, not written as an expense, until the transfer-back QR
      // is confirmed on the SavingsQR page — see PendingSavingsItem.
      await appendPendingSavingsItem(row);
      pendingSavingsRowsWritten += 1;
    } else {
      await appendPriceHistoryRow(row);
      priceHistoryRowsWritten += 1;
    }
  }

  // Remembered after a successful write, not before, so a rejected
  // reconciliation never teaches the mapping a store name the user didn't
  // actually confirm.
  if (slip?.payee && store) {
    await upsertSlipPayeeMapping(slip.payee, store);
  }

  res.json({
    success: true,
    new_master_items_added: newMasterItems,
    price_history_rows_written: priceHistoryRowsWritten,
    pending_savings_rows_written: pendingSavingsRowsWritten,
  });
});
