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

# Two rapidfuzz score (0-100) thresholds, because "good enough to suggest"
# and "good enough to decide for the user" are different questions:
#
# - Below CONFIDENCE, a candidate isn't worth showing at all.
# - At or above AUTO_APPLY, the top candidate is pre-selected and the line
#   needs no attention.
# - In between, candidates are offered but nothing is selected -- the user
#   has to choose.
#
# The gap exists because receipts routinely don't print the brand. "นมสด250ml"
# scores 64 against both "นมสด โฟร์โมสต์ 250ml" and "นมสด ดัชมิลล์ 250ml" --
# identically, because the deciding information isn't in the text at all. No
# scorer can break that tie; only the person who did the shopping can. The
# same goes for a size or brand the receipt abbreviates (79-81). Meanwhile
# pure spacing noise, "นมสดUHT250ml" vs "นมสด UHT 250ml", scores 92, which is
# a real match and shouldn't cost a tap. 90 separates the two groups.
MATCH_CONFIDENCE_THRESHOLD = int(_env("MATCH_CONFIDENCE_THRESHOLD", "60"))
MATCH_AUTO_APPLY_THRESHOLD = int(_env("MATCH_AUTO_APPLY_THRESHOLD", "90"))

# How many ranked alternatives /match hands back for the picker.
MATCH_CANDIDATE_LIMIT = int(_env("MATCH_CANDIDATE_LIMIT", "5"))

# The savings account's PromptPay-linked phone number / national ID /
# e-wallet ID (whichever it is; digit count picks the right QR field).
# Personal financial info, so it's not something the frontend sends —
# it's set once here and used as the default QR destination.
SAVINGS_PROMPTPAY_ID = _env("SAVINGS_PROMPTPAY_ID")
