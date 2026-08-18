import "dotenv/config";
// Must load before any router: it patches Express so a rejected promise
// inside an async route handler reaches the error middleware below instead
// of leaving the request hanging forever with no response — Express 4
// (unlike 5) does not do this on its own.
import "express-async-errors";
import cors from "cors";
import express from "express";
import { budgetRouter } from "./routes/budget";
import { dashboardRouter } from "./routes/dashboard";
import { expensesRouter } from "./routes/expenses";
import { incomeRouter } from "./routes/income";
import { pricesRouter } from "./routes/prices";
import { qrRouter } from "./routes/qr";
import { receiptRouter } from "./routes/receipt";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/receipt", receiptRouter);
app.use("/prices", pricesRouter);
app.use("/budget", budgetRouter);
app.use("/dashboard", dashboardRouter);
app.use("/income", incomeRouter);
app.use("/expenses", expensesRouter);
app.use("/qr", qrRouter);

// Last middleware: anything a route threw or its promise rejected with
// (a Sheets API error, most often — e.g. a tab from SETUP.md the user's
// real Sheet doesn't have yet) lands here instead of hanging the request.
// The message is forwarded as-is, same as every route's own 400s already
// do — this is a personal tool, not a public API with something to hide
// from its one user, and "SavingsWithdrawals tab missing" said plainly
// beats a generic "something went wrong" every caller would have to
// cross-reference against the server log to diagnose.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[controller] request failed:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
});

const port = process.env.PORT ?? 3001;
if (require.main === module) {
  app.listen(port, () => console.log(`Controller listening on :${port}`));
}

export default app;
