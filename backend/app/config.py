import os

TYPHOON_API_KEY = os.environ.get("TYPHOON_API_KEY", "")

# TODO: verify against a real Typhoon account/key — docs.opentyphoon.ai
# blocked automated fetches while researching this, so this default is
# taken from secondary sources (FAQ/OCR doc pages, typhoon-ocr package
# README) rather than confirmed directly against the API.
TYPHOON_BASE_URL = os.environ.get("TYPHOON_BASE_URL", "https://api.opentyphoon.ai/v1")
TYPHOON_OCR_MODEL = os.environ.get("TYPHOON_OCR_MODEL", "typhoon-ocr")

OCR_MOCK_MODE = os.environ.get("OCR_MOCK_MODE", "true").lower() == "true"

# Below this rapidfuzz score (0-100), treat a match as unreliable and let
# the frontend prompt the user to pick the master item manually.
MATCH_CONFIDENCE_THRESHOLD = int(os.environ.get("MATCH_CONFIDENCE_THRESHOLD", "60"))
