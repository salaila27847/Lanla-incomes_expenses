"""Vercel serverless entry point, served at /api/ocr."""

from fastapi import FastAPI

from app.routers.ocr import router

app = FastAPI()
app.include_router(router)
