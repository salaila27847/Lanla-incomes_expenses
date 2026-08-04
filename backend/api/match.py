"""Vercel serverless entry point, served at /api/match."""

from fastapi import FastAPI

from app.routers.match import router

app = FastAPI()
app.include_router(router)
