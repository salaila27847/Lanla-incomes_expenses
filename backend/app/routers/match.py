from fastapi import APIRouter
from pydantic import BaseModel
from rapidfuzz import fuzz, process

from app.config import MATCH_CONFIDENCE_THRESHOLD

router = APIRouter()


class MatchRequest(BaseModel):
    raw_text: str
    candidate_master_items: list[str]


@router.post("/")
async def match_master_item(payload: MatchRequest) -> dict:
    """Fuzzy-match an OCR'd item name against the master item list.

    Returns matched=False (instead of a low-confidence guess) when the
    best score is below MATCH_CONFIDENCE_THRESHOLD, so the frontend can
    prompt the user to pick the master item manually instead of the
    receipt line silently getting mistagged. An empty candidate list
    (e.g. a brand-new install with no master items yet) is a normal
    "no match" rather than an error.
    """
    if not payload.candidate_master_items:
        return {"matched": False, "master_item_name": None, "score": 0}

    best = process.extractOne(
        payload.raw_text,
        payload.candidate_master_items,
        scorer=fuzz.WRatio,
    )
    if best is None:
        return {"matched": False, "master_item_name": None, "score": 0}

    master_item_name, score, _ = best
    matched = score >= MATCH_CONFIDENCE_THRESHOLD

    return {
        "matched": matched,
        "master_item_name": master_item_name if matched else None,
        "score": score,
    }
