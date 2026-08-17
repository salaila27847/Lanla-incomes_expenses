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
from app.fixtures.sample_slip import SAMPLE_SLIP

router = APIRouter()

STRUCTURE_PROMPT_PREFIX = (
    "You are reading OCR output of a Thai retail receipt. Extract every "
    "purchased line item. Respond with ONLY valid JSON (no markdown fences, "
    "no commentary) in this exact shape:\n"
    '{"store": "<store name or null>", "purchased_at": "<YYYY-MM-DD or null>", '
    '"items": [{"id": "<1-based index as string>", "raw_text": "<item name '
    'exactly as printed>", "quantity": <number>, "line_total": <number>, '
    '"discount": <number>}], "bill_discount": <number>}\n'
    "quantity is how many units of that item were bought (1 if the receipt "
    "doesn't say). line_total is the amount charged for the whole line "
    "BEFORE any discount, exactly as printed -- copy the number, do not "
    "compute a per-unit price or add lines together.\n"
    "discount is an amount taken off that one item, as a positive number "
    "(0 if none). A discount printed directly under an item belongs to that "
    "item -- do NOT list it as an item of its own.\n"
    "bill_discount is a discount applied to the whole receipt rather than to "
    "any single item, as a positive number (0 if none). Coupons, member "
    "discounts and totals labelled ส่วนลดท้ายบิล go here.\n"
    "Include every line that has a price, even if the item name is unclear "
    "or abbreviated. Do not invent items that aren't on the receipt, and "
    "never list a discount, a subtotal, a total, VAT, or change as an item.\n\n"
    "OCR text:\n"
)

# A transfer/payment slip (Make by KBank, PromptPay, etc.) carries no
# product lines -- only who was paid, when, and how much -- so it gets its
# own prompt and schema rather than being forced through STRUCTURE_PROMPT_PREFIX,
# which would otherwise leave the model inventing an items list to satisfy
# a shape the document doesn't have.
SLIP_PROMPT_PREFIX = (
    "You are reading OCR output of a Thai bank transfer or payment slip -- "
    "NOT an itemised retail receipt. It has no product lines, only who was "
    "paid, when, and how much. Respond with ONLY valid JSON (no markdown "
    "fences, no commentary) in this exact shape:\n"
    '{"payee": "<name of the person or shop that received the money, or '
    'null>", "purchased_at": "<YYYY-MM-DD or null>", "amount": <the total '
    'amount transferred, as a number>, "transaction_id": "<the '
    'transaction/reference ID printed on the slip, or null>"}\n'
    "amount is the total that actually moved in this transfer, exactly as "
    "printed -- not the fee, and not a subtotal.\n"
)


def _positive_amount(raw) -> float:
    """A discount as a non-negative number, however the model wrote it.

    Receipts print discounts as negatives ("-20.00") and the model copies
    that about half the time, so the sign is taken off rather than trusted.
    Anything unparsable is no discount, which is the safe direction: it
    leaves the line at its printed price instead of inventing a saving.
    """
    try:
        return round(abs(float(raw)), 2)
    except (TypeError, ValueError):
        return 0.0


def _normalise_items(parsed: dict) -> dict:
    """Turn each line into a unit price plus a quantity.

    The prompt asks for the line total and the quantity, both of which are
    printed on the receipt, and the division happens here. Asking the model
    for a per-unit price instead would put arithmetic in the least reliable
    part of the pipeline -- and getting it wrong is invisible, since a
    plausible number just becomes that product's recorded price.

    `price` stays the response's field name and now means the unit price:
    for the quantity-1 lines that are most of a receipt, nothing changes.

    Discounts come back as positive amounts -- per line, plus a
    `bill_discount` for anything taken off the receipt as a whole. Both are
    kept out of the unit price so the price history keeps the printed price:
    a promo that won't be there next time shouldn't become what a product
    costs. What was paid is price * quantity - discount.
    """
    items = []
    for index, item in enumerate(parsed.get("items") or [], start=1):
        try:
            quantity = int(float(item.get("quantity") or 1))
        except (TypeError, ValueError):
            quantity = 1
        quantity = max(1, quantity)

        # Older prompts (and a model that ignores the new schema) send
        # `price` as the whole line; treat that as a line total of one unit.
        raw_total = item.get("line_total")
        if raw_total is None:
            raw_total = item.get("price", 0)
        try:
            line_total = float(raw_total)
        except (TypeError, ValueError):
            line_total = 0.0

        items.append(
            {
                "id": str(item.get("id") or index),
                "raw_text": str(item.get("raw_text") or ""),
                "quantity": quantity,
                "price": round(line_total / quantity, 2),
                "discount": _positive_amount(item.get("discount")),
            }
        )

    return {
        "store": parsed.get("store"),
        "purchased_at": parsed.get("purchased_at"),
        "items": items,
        "bill_discount": _positive_amount(parsed.get("bill_discount")),
    }


def _normalise_slip(parsed: dict) -> dict:
    """Turn the structuring model's transfer-slip JSON into a fixed shape.

    A slip has no items, so unlike _normalise_items there's no quantity or
    discount arithmetic here -- just the four fields, with an unparsable
    amount landing on 0.0 rather than crashing the request.
    """
    try:
        amount = round(float(parsed.get("amount")), 2)
    except (TypeError, ValueError):
        amount = 0.0

    return {
        "payee": parsed.get("payee"),
        "purchased_at": parsed.get("purchased_at"),
        "amount": amount,
        "transaction_id": parsed.get("transaction_id"),
    }


async def _log_diagnostics(http_client: httpx.AsyncClient, headers: dict) -> None:
    """On a failed Typhoon call, dump the config and the reachable model IDs.

    Which models an account can see is the one thing that can't be checked
    from the code or the docs -- it varies per key -- so a "Model not found"
    otherwise costs a guess-and-redeploy cycle per candidate name. Only the
    key's length and last 4 chars are logged, never the key itself; that's
    enough to tell "wrong/stale key" apart from "wrong model".
    """
    print(
        f"[ocr] base_url={TYPHOON_BASE_URL!r} ocr_model={TYPHOON_OCR_MODEL!r} "
        f"text_model={TYPHOON_TEXT_MODEL!r} key_len={len(TYPHOON_API_KEY)} "
        f"key_suffix={TYPHOON_API_KEY[-4:]!r}"
    )

    response = None
    try:
        response = await http_client.get(f"{TYPHOON_BASE_URL}/models", headers=headers)
        # Typhoon returns a bare list here, not OpenAI's {"data": [...]}
        # envelope, and entries may be plain strings rather than objects.
        payload = response.json()
        entries = payload.get("data", []) if isinstance(payload, dict) else payload
        model_ids = [e.get("id") if isinstance(e, dict) else e for e in entries]
        if model_ids:
            print(f"[ocr] models available to this key: {model_ids}")
        else:
            # Shape we didn't anticipate -- the raw body is more use than [].
            print(f"[ocr] unrecognised /models shape, raw: {response.text[:1000]!r}")
    except Exception as exc:  # diagnostics must never mask the real failure
        print(f"[ocr] could not list available models: {exc!r}")
        if response is not None:
            print(f"[ocr] raw /models response: {response.text[:1000]!r}")


async def _fetch_ocr_text(
    http_client: httpx.AsyncClient,
    auth_headers: dict,
    image_bytes: bytes,
    filename: str,
    content_type: str,
) -> str:
    """Stage 1, shared by every document type: typhoon-ocr is only served
    through this dedicated multipart endpoint (not /chat/completions), and
    it has no custom prompt -- it just returns the document's raw OCR text,
    receipt or slip alike."""
    ocr_response = await http_client.post(
        f"{TYPHOON_BASE_URL}/ocr",
        headers=auth_headers,
        files={"file": (filename, image_bytes, content_type)},
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
        # Printed (not just raised) because /controller only forwards our
        # status code to the PWA, not this detail -- Vercel logs are the
        # only place the actual Typhoon error body is visible.
        print(f"[ocr] OCR call failed: {ocr_response.status_code} {ocr_response.text}")
        await _log_diagnostics(http_client, auth_headers)
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
        return json.loads(raw_content).get("natural_text", raw_content)
    except json.JSONDecodeError:
        return raw_content


async def _structure(http_client: httpx.AsyncClient, auth_headers: dict, prompt: str) -> dict:
    """Stage 2, shared by every document type: a regular chat model turns
    stage 1's raw OCR text into whatever JSON schema `prompt` asked for."""
    structure_response = await http_client.post(
        f"{TYPHOON_BASE_URL}/chat/completions",
        headers=auth_headers,
        json={"model": TYPHOON_TEXT_MODEL, "messages": [{"role": "user", "content": prompt}]},
    )
    if structure_response.status_code != 200:
        print(
            f"[ocr] structuring call failed: {structure_response.status_code} "
            f"{structure_response.text}"
        )
        await _log_diagnostics(http_client, auth_headers)
        raise HTTPException(
            status_code=502,
            detail=f"Typhoon structuring call returned {structure_response.status_code}: "
            f"{structure_response.text}",
        )

    try:
        content = structure_response.json()["choices"][0]["message"]["content"]
        return json.loads(content)
    except (json.JSONDecodeError, KeyError, IndexError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Typhoon structuring returned an unparsable response: {exc}",
        ) from exc


@router.post("/")
async def scan_receipt(image: UploadFile = File(...)) -> dict:
    """Line-item OCR: split one long receipt image into per-line entries.

    Returns {"store", "purchased_at", "items": [{"id", "raw_text",
    "quantity", "price"}]} either way, so callers don't need to know whether
    OCR_MOCK_MODE is on. `price` is per unit; multiply by `quantity` for
    what the line cost.
    """
    image_bytes = await image.read()

    if OCR_MOCK_MODE:
        return _normalise_items(SAMPLE_RECEIPT)

    if not TYPHOON_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="TYPHOON_API_KEY is not set and OCR_MOCK_MODE is off",
        )

    auth_headers = {"Authorization": f"Bearer {TYPHOON_API_KEY}"}
    async with httpx.AsyncClient(timeout=60) as http_client:
        ocr_text = await _fetch_ocr_text(
            http_client,
            auth_headers,
            image_bytes,
            image.filename or "receipt.jpg",
            image.content_type or "image/jpeg",
        )
        parsed = await _structure(http_client, auth_headers, STRUCTURE_PROMPT_PREFIX + ocr_text)

    return _normalise_items(parsed)


@router.post("/slip")
async def scan_slip(image: UploadFile = File(...)) -> dict:
    """Transfer-slip OCR: a slip has no product lines, only who was paid,
    when, and how much, so it gets its own schema instead of a forced-empty
    `items` list.

    Returns {"payee", "purchased_at", "amount", "transaction_id"} either
    way, so callers don't need to know whether OCR_MOCK_MODE is on.
    """
    image_bytes = await image.read()

    if OCR_MOCK_MODE:
        return _normalise_slip(SAMPLE_SLIP)

    if not TYPHOON_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="TYPHOON_API_KEY is not set and OCR_MOCK_MODE is off",
        )

    auth_headers = {"Authorization": f"Bearer {TYPHOON_API_KEY}"}
    async with httpx.AsyncClient(timeout=60) as http_client:
        ocr_text = await _fetch_ocr_text(
            http_client,
            auth_headers,
            image_bytes,
            image.filename or "slip.jpg",
            image.content_type or "image/jpeg",
        )
        parsed = await _structure(http_client, auth_headers, SLIP_PROMPT_PREFIX + ocr_text)

    return _normalise_slip(parsed)
