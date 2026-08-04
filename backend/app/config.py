import os

TYPHOON_API_KEY = os.environ.get("TYPHOON_API_KEY", "")

TYPHOON_BASE_URL = os.environ.get("TYPHOON_BASE_URL", "https://api.opentyphoon.ai/v1")
TYPHOON_OCR_MODEL = os.environ.get("TYPHOON_OCR_MODEL", "typhoon-ocr")

OCR_MOCK_MODE = os.environ.get("OCR_MOCK_MODE", "true").lower() == "true"

# Below this rapidfuzz score (0-100), treat a match as unreliable and let
# the frontend prompt the user to pick the master item manually.
MATCH_CONFIDENCE_THRESHOLD = int(os.environ.get("MATCH_CONFIDENCE_THRESHOLD", "60"))

# The savings account's PromptPay-linked phone number / national ID /
# e-wallet ID (whichever it is; digit count picks the right QR field).
# Personal financial info, so it's not something the frontend sends —
# it's set once here and used as the default QR destination.
SAVINGS_PROMPTPAY_ID = os.environ.get("SAVINGS_PROMPTPAY_ID", "")
