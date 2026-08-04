import base64
import json

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.config import (
    OCR_MOCK_MODE,
    TYPHOON_API_KEY,
    TYPHOON_BASE_URL,
    TYPHOON_OCR_MODEL,
)
from app.fixtures.sample_receipt import SAMPLE_RECEIPT

router = APIRouter()

OCR_PROMPT = (
    "You are reading a Thai retail receipt. Extract every purchased line "
    "item. Respond with ONLY valid JSON (no markdown fences, no commentary) "
    "in this exact shape:\n"
    '{"store": "<store name or null>", "purchased_at": "<YYYY-MM-DD or null>", '
    '"items": [{"id": "<1-based index as string>", "raw_text": "<item name '
    'exactly as printed>", "price": <number>}]}\n'
    "Include every line that has a price, even if the item name is unclear "
    "or abbreviated. Do not invent items that aren't on the receipt."
)


@router.post("/")
async def scan_receipt(image: UploadFile = File(...)) -> dict:
    """Line-item OCR: split one long receipt image into per-line entries.

    Returns {"store", "purchased_at", "items": [{"id", "raw_text", "price"}]}
    either way, so callers don't need to know whether OCR_MOCK_MODE is on.
    """
    image_bytes = await image.read()

    if OCR_MOCK_MODE:
        return SAMPLE_RECEIPT

    if not TYPHOON_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="TYPHOON_API_KEY is not set and OCR_MOCK_MODE is off",
        )

    from openai import OpenAI  # only needed on the real-API path

    client = OpenAI(base_url=TYPHOON_BASE_URL, api_key=TYPHOON_API_KEY)
    encoded_image = base64.b64encode(image_bytes).decode("utf-8")
    content_type = image.content_type or "image/jpeg"

    try:
        response = client.chat.completions.create(
            model=TYPHOON_OCR_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": OCR_PROMPT},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{content_type};base64,{encoded_image}"
                            },
                        },
                    ],
                }
            ],
        )
        parsed = json.loads(response.choices[0].message.content)
    except (json.JSONDecodeError, KeyError, IndexError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Typhoon OCR returned an unparsable response: {exc}",
        ) from exc

    return parsed
