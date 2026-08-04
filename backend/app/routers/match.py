from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class MatchRequest(BaseModel):
    raw_text: str
    candidate_master_items: list[str]


@router.post("/")
async def match_master_item(payload: MatchRequest) -> dict:
    """Fuzzy-match an OCR'd item name against the master item list.

    TODO: use rapidfuzz.process.extractOne(payload.raw_text,
    payload.candidate_master_items) and return the best match + score.
    """
    raise HTTPException(status_code=501, detail="Fuzzy matching not implemented yet")
