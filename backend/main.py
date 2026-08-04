"""Local dev entry point: `uvicorn main:app --reload`.

Mounts the same routers Vercel serves individually under api/ocr.py,
api/match.py, and api/qr.py, so local development has one server with
all endpoints instead of three.
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
