"""Vercel serverless entry point, served at /api/qr."""

from fastapi import FastAPI

from app.routers.qr import router

app = FastAPI()
app.include_router(router)
