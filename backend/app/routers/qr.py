import base64
from io import BytesIO

import qrcode
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import SAVINGS_PROMPTPAY_ID
from app.promptpay import build_promptpay_payload

router = APIRouter()


class QrRequest(BaseModel):
    amount_thb: float
    promptpay_id: str | None = None  # falls back to SAVINGS_PROMPTPAY_ID if omitted


@router.post("/")
async def generate_promptpay_qr(payload: QrRequest) -> dict:
    """Generate a dynamic PromptPay QR for a savings-account transfer."""
    if payload.amount_thb <= 0:
        raise HTTPException(status_code=400, detail="amount_thb must be greater than 0")

    target = payload.promptpay_id or SAVINGS_PROMPTPAY_ID
    if not target:
        raise HTTPException(
            status_code=400,
            detail="No PromptPay ID configured — set SAVINGS_PROMPTPAY_ID or pass promptpay_id",
        )

    emv_payload = build_promptpay_payload(target, payload.amount_thb)

    image = qrcode.make(emv_payload)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")

    return {"payload": emv_payload, "qr_data_url": f"data:image/png;base64,{encoded}"}
