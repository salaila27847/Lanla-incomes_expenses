"""Vercel serverless entry point: one function serving every route.

Mirrors ../main.py (the local dev entry point) so both environments run
identical routing. A previous version split each router into its own
api/*.py file with a vercel.json rewrite mapping /ocr -> api/ocr.py etc.,
but that rewrite doesn't resolve to the per-file build outputs on Vercel
(every route 404s at the platform level) -- one function sidesteps it.
"""

from fastapi import FastAPI

from app.routers import match, ocr, qr

app = FastAPI(title="Smart Expense & Price Tracker API")

app.include_router(ocr.router, prefix="/ocr", tags=["ocr"])
app.include_router(match.router, prefix="/match", tags=["match"])
app.include_router(qr.router, prefix="/qr", tags=["qr"])


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
