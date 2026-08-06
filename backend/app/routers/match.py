from fastapi import APIRouter
from pydantic import BaseModel
from rapidfuzz import fuzz, process

from app.config import (
    MATCH_AUTO_APPLY_THRESHOLD,
    MATCH_CANDIDATE_LIMIT,
    MATCH_CONFIDENCE_THRESHOLD,
)

router = APIRouter()


class MatchRequest(BaseModel):
    raw_text: str
    candidate_master_items: list[str]


def _no_match() -> dict:
    return {"matched": False, "master_item_name": None, "score": 0, "candidates": []}


@router.post("/")
async def match_master_item(payload: MatchRequest) -> dict:
    """Rank master items against an OCR'd receipt line.

    Returns every candidate worth showing, not just the winner, plus a
    `matched` flag saying whether the top one is safe to pre-select.

    A single threshold forced a choice between guessing and giving up, and
    the middle ground is where most receipt lines live: when the receipt
    doesn't print the brand, every brand of that product scores the same,
    so picking the top one is a coin flip that quietly merges two products'
    price histories. Anything between the thresholds is now offered but not
    chosen -- the picker shows these candidates and waits.

    `score` is always the best raw score, even when nothing clears the
    confidence floor, so the frontend can say how close it got.

    An empty candidate list (a brand-new install with no master items yet)
    is a normal "no match" rather than an error.
    """
    if not payload.candidate_master_items:
        return _no_match()

    ranked = process.extract(
        payload.raw_text,
        payload.candidate_master_items,
        scorer=fuzz.WRatio,
        limit=MATCH_CANDIDATE_LIMIT,
    )
    if not ranked:
        return _no_match()

    best_name, best_score, _ = ranked[0]
    candidates = [
        {"name": name, "score": score}
        for name, score, _ in ranked
        if score >= MATCH_CONFIDENCE_THRESHOLD
    ]
    matched = bool(candidates) and best_score >= MATCH_AUTO_APPLY_THRESHOLD

    return {
        "matched": matched,
        # Only filled in when it's safe to apply without asking; the picker
        # reads `candidates` for everything else.
        "master_item_name": best_name if matched else None,
        "score": best_score,
        "candidates": candidates,
    }
