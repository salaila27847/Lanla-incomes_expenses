import json

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile

from app.config import (
    OCR_MOCK_MODE,
    TYPHOON_API_KEY,
    TYPHOON_BASE_URL,
    TYPHOON_OCR_MODEL,
    TYPHOON_TEXT_MODEL,
)
from app.fixtures.sample_receipt import SAMPLE_RECEIPT

router = APIRouter()

STRUCTURE_PROMPT_PREFIX = (
    "You are reading OCR output of a Thai retail receipt. Extract every "
    "purchased line item. Respond with ONLY valid JSON (no markdown fences, "
    "no commentary) in this exact shape:\n"
    '{"store": "<store name or null>", "purchased_at": "<YYYY-MM-DD or null>", '
    '"items": [{"id": "<1-based index as string>", "raw_text": "<item name '
    'exactly as printed>", "price": <number>}]}\n'
    "Include every line that has a price, even if the item name is unclear "
    "or abbreviated. Do not invent items that aren't on the receipt.\n\n"
    "OCR text:\n"
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

    # Never log the key itself -- length + last 4 chars is enough to tell
    # "wrong/stale key" apart from "wrong model" without leaking the secret.
    print(
        f"[ocr] base_url={TYPHOON_BASE_URL!r} ocr_model={TYPHOON_OCR_MODEL!r} "
        f"text_model={TYPHOON_TEXT_MODEL!r} key_len={len(TYPHOON_API_KEY)} "
        f"key_suffix={TYPHOON_API_KEY[-4:]!r}"
    )

    content_type = image.content_type or "image/jpeg"
    auth_headers = {"Authorization": f"Bearer {TYPHOON_API_KEY}"}

    async with httpx.AsyncClient(timeout=60) as http_client:
        # Stage 1: typhoon-ocr is only served through this dedicated
        # multipart endpoint (not /chat/completions), and it has no custom
        # prompt -- it just returns the document's raw OCR text.
        ocr_response = await http_client.post(
            f"{TYPHOON_BASE_URL}/ocr",
            headers=auth_headers,
            files={"file": (image.filename or "receipt.jpg", image_bytes, content_type)},
            data={
                "model": TYPHOON_OCR_MODEL,
                "task_type": "default",
                "max_tokens": "16384",
                "temperature": "0.1",
                "top_p": "0.6",
                "repetition_penalty": "1.2",
            },
        )
        if ocr_response.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Typhoon OCR returned {ocr_response.status_code}: {ocr_response.text}",
            )

        page_results = ocr_response.json().get("results", [])
        if not page_results or not page_results[0].get("success"):
            error = page_results[0].get("error") if page_results else "no results"
            raise HTTPException(status_code=502, detail=f"Typhoon OCR failed: {error}")

        raw_content = page_results[0]["message"]["choices"][0]["message"]["content"]
        try:
            ocr_text = json.loads(raw_content).get("natural_text", raw_content)
        except json.JSONDecodeError:
            ocr_text = raw_content

        # Stage 2: a regular chat model turns the raw OCR text into our
        # {store, purchased_at, items} schema.
        structure_response = await http_client.post(
            f"{TYPHOON_BASE_URL}/chat/completions",
            headers=auth_headers,
            json={
                "model": TYPHOON_TEXT_MODEL,
                "messages": [
                    {"role": "user", "content": STRUCTURE_PROMPT_PREFIX + ocr_text}
                ],
            },
        )
        if structure_response.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Typhoon structuring call returned {structure_response.status_code}: "
                f"{structure_response.text}",
            )

    try:
        content = structure_response.json()["choices"][0]["message"]["content"]
        parsed = json.loads(content)
    except (json.JSONDecodeError, KeyError, IndexError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Typhoon structuring returned an unparsable response: {exc}",
        ) from exc

    return parsed
