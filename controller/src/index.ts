import "dotenv/config";
import cors from "cors";
import express from "express";
import { budgetRouter } from "./routes/budget";
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
app.use("/qr", qrRouter);

const port = process.env.PORT ?? 3001;
if (require.main === module) {
  app.listen(port, () => console.log(`Controller listening on :${port}`));
}

export default app;
