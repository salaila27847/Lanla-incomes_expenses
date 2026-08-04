from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class QrRequest(BaseModel):
    amount_thb: float
    promptpay_id: str


@router.post("/")
async def generate_promptpay_qr(payload: QrRequest) -> dict:
    """Generate a dynamic PromptPay QR for a savings-account transfer.

    TODO: build the PromptPay EMVCo payload for `promptpay_id` +
    `amount_thb`, render it with the `qrcode` package, and return a
    base64 data URL the PWA can display directly.
    """
    raise HTTPException(status_code=501, detail="QR generation not implemented yet")
