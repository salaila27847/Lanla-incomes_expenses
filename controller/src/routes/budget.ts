import { Router } from "express";

export const budgetRouter = Router();

budgetRouter.get("/", async (_req, res) => {
  // TODO: readRange("Budget!A:D") for today's food/goods totals against
  // the 5,000/5,000 THB daily caps, plus the must-pay checklist.
  res.status(501).json({ error: "Budget lookup not implemented yet" });
});

budgetRouter.post("/must-pay/:id/mark-paid", async (_req, res) => {
  // TODO: update the matching row in Sheets to 🟢 จ่ายแล้ว once a
  // matching receipt scan is confirmed.
  res.status(501).json({ error: "Marking must-pay items as paid not implemented yet" });
});
