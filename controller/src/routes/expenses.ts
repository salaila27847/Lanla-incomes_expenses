import { Router } from "express";
import { loadCycles } from "../cycleService";
import { isCycleKey, isDate } from "../cycles";
import {
  appendMasterItem,
  appendPriceHistoryRow,
  deletePriceHistoryRow,
  readMasterItems,
  readPriceHistory,
  updatePriceHistoryRow,
  type ItemCategory,
  type PriceHistoryInput,
} from "../sheets/client";

export const expensesRouter = Router();

/**
 * Direct access to the PriceHistory rows a receipt scan writes.
 *
 * Scanning used to be the only way to create one, which made a misread
 * line permanent: no way to add what the scan missed, fix a wrong price,
 * or remove a duplicate. These are the same rows, edited by hand.
 */

interface ExpenseBody {
  date?: unknown;
  store?: unknown;
  masterItemName?: unknown;
  category?: unknown;
  price?: unknown;
  quantity?: unknown;
}

type Parsed = { ok: true; value: Partial<PriceHistoryInput> } | { ok: false; error: string };

/**
 * Validates whichever fields are present. `partial` is what separates a
 * PUT (change the price, leave everything else) from a POST (a row needs
 * every field before it can exist).
 */
function parseExpense(body: ExpenseBody, partial: boolean): Parsed {
  const value: Partial<PriceHistoryInput> = {};

  if (body.date !== undefined || !partial) {
    if (typeof body.date !== "string" || !isDate(body.date)) {
      return { ok: false, error: "date must be a YYYY-MM-DD date" };
    }
    value.date = body.date;
  }

  if (body.masterItemName !== undefined || !partial) {
    if (typeof body.masterItemName !== "string" || !body.masterItemName.trim()) {
      return { ok: false, error: "masterItemName is required" };
    }
    value.masterItemName = body.masterItemName.trim();
  }

  if (body.category !== undefined || !partial) {
    if (body.category !== "food" && body.category !== "goods") {
      return { ok: false, error: 'category must be "food" or "goods"' };
    }
    value.category = body.category as ItemCategory;
  }

  if (body.price !== undefined || !partial) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) {
      return { ok: false, error: "price must be a number of 0 or more" };
    }
    value.price = price;
  }

  if (body.quantity !== undefined) {
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: "quantity must be a whole number of 1 or more" };
    }
    value.quantity = quantity;
  } else if (!partial) {
    value.quantity = 1;
  }

  if (body.store !== undefined) {
    value.store = typeof body.store === "string" && body.store.trim() ? body.store.trim() : null;
  } else if (!partial) {
    value.store = null;
  }

  return { ok: true, value };
}

/** Keeps the master item list in step, exactly as /receipt/confirm does —
 *  otherwise a name typed here never becomes pickable anywhere else. */
async function ensureMasterItem(name: string, category: ItemCategory): Promise<void> {
  const existing = await readMasterItems();
  if (!existing.some((item) => item.name === name)) {
    await appendMasterItem(name, category);
  }
}

expensesRouter.get("/", async (req, res) => {
  const cycleKey = typeof req.query.cycle === "string" ? req.query.cycle : null;
  const rows = await readPriceHistory();

  if (!cycleKey) {
    res.json({ expenses: [...rows].sort((a, b) => b.date.localeCompare(a.date)) });
    return;
  }
  if (!isCycleKey(cycleKey)) {
    res.status(400).json({ error: "cycle must look like YYYY-MM" });
    return;
  }

  const [cycle] = await loadCycles(cycleKey, cycleKey);
  const expenses = rows
    .filter((row) => row.date >= cycle.payday && row.date <= cycle.end)
    .sort((a, b) => b.date.localeCompare(a.date));

  res.json({ cycle, expenses });
});

expensesRouter.post("/", async (req, res) => {
  const parsed = parseExpense(req.body as ExpenseBody, false);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const input = parsed.value as PriceHistoryInput;
  await ensureMasterItem(input.masterItemName, input.category);
  res.status(201).json(await appendPriceHistoryRow(input));
});

expensesRouter.put("/:id", async (req, res) => {
  const parsed = parseExpense(req.body as ExpenseBody, true);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  if (parsed.value.masterItemName && parsed.value.category) {
    await ensureMasterItem(parsed.value.masterItemName, parsed.value.category);
  }

  const updated = await updatePriceHistoryRow(req.params.id, parsed.value);
  if (!updated) {
    res.status(404).json({ error: "expense not found" });
    return;
  }
  res.json(updated);
});

expensesRouter.delete("/:id", async (req, res) => {
  const deleted = await deletePriceHistoryRow(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "expense not found" });
    return;
  }
  res.json({ success: true, id: req.params.id });
});
