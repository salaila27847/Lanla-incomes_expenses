import { Router } from "express";

export const pricesRouter = Router();

pricesRouter.get("/", async (_req, res) => {
  // TODO: readRange("PriceHistory!A:D"), filter rows by the `item` query
  // param (fuzzy or exact match on master item name), and group results
  // by store for the PWA's timeline view.
  res.status(501).json({ error: "Price history lookup not implemented yet" });
});
