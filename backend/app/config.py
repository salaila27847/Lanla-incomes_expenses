import os


# Every value here comes from a hosting dashboard, which makes two things
# routine that a .env file makes rare:
#
# - Pasted values pick up stray whitespace or tab characters. A leading
#   tab on TYPHOON_BASE_URL broke httpx's URL parser on every scan while
#   looking perfectly correct in the UI.
# - A variable gets created but left blank. `os.environ.get(name, default)`
#   returns "" for those, not the default, so a blank
#   MATCH_CONFIDENCE_THRESHOLD used to crash the app at import.
#
# Stripping and treating blank as absent makes both harmless.
def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


TYPHOON_API_KEY = _env("TYPHOON_API_KEY")

TYPHOON_BASE_URL = _env("TYPHOON_BASE_URL", "https://api.opentyphoon.ai/v1")
# typhoon-ocr is only served through the dedicated POST {base}/ocr endpoint
# (multipart, fixed params, no custom prompt) -- not /chat/completions. It
# returns raw OCR text, so a second, regular chat model turns that into our
# {store, purchased_at, items} schema.
TYPHOON_OCR_MODEL = _env("TYPHOON_OCR_MODEL", "typhoon-ocr")
TYPHOON_TEXT_MODEL = _env("TYPHOON_TEXT_MODEL", "typhoon-v2.5-30b-a3b-instruct")

OCR_MOCK_MODE = _env("OCR_MOCK_MODE", "true").lower() == "true"

# Below this rapidfuzz score (0-100), treat a match as unreliable and let
# the frontend prompt the user to pick the master item manually.
MATCH_CONFIDENCE_THRESHOLD = int(_env("MATCH_CONFIDENCE_THRESHOLD", "60"))

# The savings account's PromptPay-linked phone number / national ID /
# e-wallet ID (whichever it is; digit count picks the right QR field).
# Personal financial info, so it's not something the frontend sends —
# it's set once here and used as the default QR destination.
SAVINGS_PROMPTPAY_ID = _env("SAVINGS_PROMPTPAY_ID")
